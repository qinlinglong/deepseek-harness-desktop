// 插件市场：声明式源描述符 + 通用解析引擎。
// 设计目标：新增/更换市场源只需配置一份描述符 JSON，桌面端不再写专属解析代码。
//
// 描述符字段：
//   { id, name, url,
//     format: 'json' | 'html',
//     // json 源：
//     jsonPath: 'plugins'            // 顶层数组路径（点分），缺省尝试 plugins/packages/根数组
//     fields: { <字段>: <规则> }      // 规则见 resolveJsonField
//     // html 源：
//     entryRegex: '正则(含捕获组)'     // 命中一个插件的片段
//     fields: { <字段>: <规则> }      // 规则见 resolveHtmlField
//   }
//
// 字段规则（fields 的取值）：
//   json:  'a.b.c' | ['a','b']（取首个非空）| { json, regex, group, join, limit, const }
//   html:  'match:1' | 'attr:name' | 'const:x' | 'regex:..' | { match, contextAttr, radius, after, regex, group, const }
// 必填字段为 pkg（安装包规格）；缺失则丢弃该条目。
'use strict'
const https = require('https')
const http = require('http')
const { spawn } = require('node:child_process')

// ---------------- 内置预设（均为完整描述符，零代码即可解析） ----------------
const DEFAULT_MARKET_SOURCES = [
  {
    id: 'dshmarket',
    name: 'dsh.market',
    type: 'dshmarket',
    format: 'json',
    url: 'https://dsh.market/plugins.json',
    jsonPath: 'plugins',
    fields: {
      pkg: { json: ['install.commands[0]', 'install.command', 'name'], regex: 'add\\s+(\\S+)', group: 1 },
      name: 'name',
      description: ['descriptionZh', 'description'],
      version: 'version',
      category: { json: 'tags', join: ', ', limit: 3 },
      homepage: 'homepage',
    },
  },
  {
    id: 'awesome',
    name: 'awesome-dsh-plugin.com',
    type: 'awesome',
    format: 'html',
    url: 'https://awesome-dsh-plugin.com/',
    entryRegex: 'data-cmd="[^"]*dsh\\s+plugin\\s+--profile\\s+web\\s+add\\s+([^"\\s@]+)',
    fields: {
      pkg: 'match:1',
      name: 'attr:name',
      category: 'attr:data-cat',
      description: 'attr:data-desc',
    },
  },
]

// 兼容旧 type 字段（无 format）的默认值
const TYPE_DEFAULTS = {
  dshmarket: { format: 'json', jsonPath: 'plugins' },
  awesome: {
    format: 'html',
    entryRegex: 'data-cmd="[^"]*dsh\\s+plugin\\s+--profile\\s+web\\s+add\\s+([^"\\s@]+)',
    fields: { pkg: 'match:1', name: 'attr:name', category: 'attr:data-cat', description: 'attr:data-desc' },
  },
  catalog: { format: 'json', jsonPath: '' },
}

function normalizeMarketSources(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_MARKET_SOURCES.map((s) => ({ ...s }))
  const out = arr
    .filter((s) => s && s.url)
    .map((s, i) => {
      let src = { ...s }
      if (!src.id) src.id = 'src-' + i + '-' + Date.now()
      if (!src.name) src.name = src.url
      if (!src.format) {
        const d = TYPE_DEFAULTS[src.type]
        if (d) {
          // 用类型默认值补全 format/jsonPath/entryRegex/fields，再被用户字段覆盖
          src = { ...d, ...src }
        }
      }
      if (!src.format) src.format = 'json'
      return src
    })
  return out.length ? out : DEFAULT_MARKET_SOURCES.map((s) => ({ ...s }))
}

// ---------------- 最小 HTTP GET（跟随重定向 + 超时） ----------------
function httpGetText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 20000
    const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 5
    let redirects = 0
    const doReq = (u) => {
      let parsed
      try { parsed = new URL(u) } catch (e) { return reject(e) }
      const mod = parsed.protocol === 'https:' ? https : http
      const req = mod.get(u, { timeout, headers: { 'user-agent': 'dsh-desktop' } }, (res) => {
        const code = res.statusCode || 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          if (redirects++ >= maxRedirects) return reject(new Error('too many redirects'))
          return doReq(new URL(res.headers.location, u).toString())
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('timeout')))
    }
    doReq(url)
  })
}

// ---------------- 路径解析（支持 a.b.c 与 a[0].b 数组下标） ----------------
function pickPath(obj, path) {
  if (path == null) return undefined
  if (Array.isArray(path)) {
    for (const p of path) {
      const v = pickPath(obj, p)
      if (v != null && v !== '') return v
    }
    return undefined
  }
  const segs = String(path).split('.')
  let cur = obj
  for (const s of segs) {
    if (cur == null) return undefined
    const m = s.match(/^([^[]+)(?:\[(\d+)\])?$/)
    if (!m) { cur = cur[s]; continue }
    cur = cur[m[1]]
    if (m[2] != null) cur = cur ? cur[Number(m[2])] : undefined
  }
  return cur
}

function normalizeJsonSpec(spec) {
  if (Array.isArray(spec)) return { json: spec }
  if (typeof spec === 'string') return { json: spec }
  return spec || {}
}
function resolveJsonField(spec, entry) {
  spec = normalizeJsonSpec(spec)
  if (spec.const != null) return String(spec.const)
  let val
  if (spec.json != null) val = pickPath(entry, spec.json)
  if ((val == null || val === '') && spec.regex) {
    const target = val != null ? String(val) : (spec.from ? String(pickPath(entry, spec.from) || '') : '')
    const m = target.match(new RegExp(spec.regex, spec.flags || ''))
    if (m) val = spec.group != null ? m[spec.group] : m[0]
  }
  if (val != null && spec.join && Array.isArray(val)) val = val.slice(0, spec.limit || 5).join(spec.join)
  return val == null ? '' : String(val)
}

function parseShortHtml(spec) {
  if (typeof spec !== 'string') return spec || {}
  if (spec.startsWith('match:')) return { match: Number(spec.slice(6)) }
  if (spec.startsWith('attr:')) return { contextAttr: spec.slice(5), radius: 800, after: 150 }
  if (spec.startsWith('const:')) return { const: spec.slice(6) }
  if (spec.startsWith('regex:')) return { regex: spec.slice(6), group: 0 }
  return { const: spec }
}
function resolveHtmlField(spec, match, docText, idx, matchedText) {
  spec = parseShortHtml(spec)
  if (spec.const != null) return String(spec.const)
  if (spec.match != null) return match[spec.match] != null ? match[spec.match] : ''
  let val = ''
  if (spec.contextAttr) {
    const radius = spec.radius != null ? spec.radius : 800
    const after = spec.after != null ? spec.after : 150
    const seg = docText.slice(Math.max(0, idx - radius), Math.min(docText.length, idx + after))
    const r = new RegExp(spec.contextAttr + '="([^"]*)"')
    const m = seg.match(r)
    if (m) val = m[1]
  }
  if (!val && spec.regex) {
    const m = matchedText.match(new RegExp(spec.regex, spec.flags || ''))
    if (m) val = spec.group != null ? m[spec.group] : m[0]
  }
  return val || ''
}

// ---------------- 解析入口 ----------------
function buildCommon(out, source) {
  if (!out.pkg) return null
  if (!out.name) out.name = out.pkg
  return { id: out.id || out.pkg, name: out.name, description: out.description || '', version: out.version || '', category: out.category || '', homepage: out.homepage || '', pkg: out.pkg, source: source.name || '' }
}

function parseJsonSource(source, body) {
  let data
  try { data = typeof body === 'string' ? JSON.parse(body) : body } catch (_) { data = {} }
  let list = []
  if (source.jsonPath) {
    const p = pickPath(data, source.jsonPath)
    if (Array.isArray(p)) list = p
  }
  if (!list.length) list = data.plugins || data.packages || (Array.isArray(data) ? data : [])
  const fields = source.fields || {}
  return list
    .map((entry, i) => {
      const out = { id: String(entry.id || entry.name || i) }
      for (const key of ['name', 'description', 'version', 'category', 'homepage', 'pkg']) {
        out[key] = fields[key] != null ? resolveJsonField(fields[key], entry) : (entry[key] != null ? String(entry[key]) : '')
      }
      return buildCommon(out, source)
    })
    .filter((p) => p)
}

function parseHtmlSource(source, body) {
  const re = new RegExp(source.entryRegex, 'g')
  const fields = source.fields || {}
  const seen = new Set()
  const out = []
  let m
  let i = 0
  while ((m = re.exec(body))) {
    const idx = m.index
    const matchedText = m[0]
    const entry = { id: 'h' + i }
    for (const key of ['name', 'description', 'version', 'category', 'homepage', 'pkg']) {
      entry[key] = fields[key] != null ? resolveHtmlField(fields[key], m, body, idx, matchedText) : ''
    }
    const built = buildCommon(entry, source)
    if (!built) continue
    if (seen.has(built.pkg)) continue
    seen.add(built.pkg)
    out.push(built)
    i++
  }
  return out
}

async function browseMarket(source) {
  const { status, body } = await httpGetText(source.url, { timeout: 25000 })
  if (status !== 200) throw new Error('市场源加载失败 (HTTP ' + status + ')')
  if (source.format === 'html') return parseHtmlSource(source, body)
  return parseJsonSource(source, body)
}

// ---------------- 安装执行器（dsh plugin --profile web add/remove） ----------------
function runDshPlugin(binPath, homeDir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-internals', binPath, 'plugin', '--profile', 'web', ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const push = (d) => { out += d.toString() }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (e) => resolve({ code: -1, log: out + '\n' + e.message }))
    child.on('exit', (code) => resolve({ code: code || 0, log: out }))
  })
}

async function listInstalledPlugins(binPath, homeDir) {
  const r = await runDshPlugin(binPath, homeDir, ['ls'])
  const out = r.log || ''
  const re = /((?:@[\w.-]+\/)?[\w.-]+)\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/g
  const out2 = []
  const seen = new Set()
  let m
  while ((m = re.exec(out))) {
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    out2.push({ name, version: m[2] })
  }
  return out2
}

module.exports = {
  DEFAULT_MARKET_SOURCES,
  normalizeMarketSources,
  httpGetText,
  browseMarket,
  parseJsonSource,
  parseHtmlSource,
  runDshPlugin,
  listInstalledPlugins,
}
