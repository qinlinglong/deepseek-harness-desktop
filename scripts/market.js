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
// 市场描述符协议（接入新市场只需按此声明，无需改解析代码）：
// {
//   id, name, type, url,
//   format: 'json' | 'html',
//   jsonPath: 'a[0].b'        // json 源条目所在的数组路径（留空=整份 JSON 为数组）
//   entryRegex: '...'          // html 源条目正则（含捕获组）
//   fields: {                  // 字段映射：标准字段 pkg/name/description/version/category/homepage
//     pkg: ...,                //   扩展字段不限名，值可为：'a.b' 路径 | 数组(多候选) | {json,regex,group,join,limit,numeric,boolean,const}
//     score: { json: 'score.total', numeric: true },
//     stars: { json: 'stars', numeric: true },
//     needsConfig: { json: 'install.needsConfig', boolean: true },
//   },
//   defaultSort: { field: 'score', dir: 'desc' }  // 可选：应用内默认排序（field 对应扩展字段名）
// }
// 特殊用法：html 源字段可用 'match:1' / 'attr:name' / 'const:x' / 'contextAttr:xx'
const DEFAULT_MARKET_SOURCES = [
  {
    id: 'dshmarket',
    name: 'dsh.market',
    type: 'dshmarket',
    format: 'json',
    url: 'https://dsh.market/plugins.json',
    jsonPath: 'plugins',
    defaultSort: { field: 'score', dir: 'desc' }, // 对齐 dsh.market 网站默认「实用分降序」
    fields: {
      pkg: { json: ['install.commands[0]', 'install.command', 'name'], regex: 'add\\s+(\\S+)', group: 1 },
      name: 'name',
      description: ['descriptionZh', 'description'],
      version: 'version',
      category: { json: 'tags', join: ', ', limit: 3 },
      homepage: 'homepage',
      // 扩展字段（不透传 pkg 等标准字段名以外的都进 meta）：数值/布尔用显式类型标注
      score: { json: 'score.total', numeric: true },
      stars: { json: 'stars', numeric: true },
      needsConfig: { json: 'install.needsConfig', boolean: true },
      pushedAt: 'pushedAt',
      createdAt: 'createdAt',
      tags: { json: 'tags' },
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
      // 旧配置（仅 type/url，无 fields）解析会提取不到 pkg 而被全部过滤成 0 个插件。
      // 按内置源的 id/type 补全标准 fields 映射，保证旧配置直接可用。
      if (!src.fields) {
        const builtin = DEFAULT_MARKET_SOURCES.find((b) => b.id === src.id || b.type === src.type)
        if (builtin && builtin.fields) {
          src.fields = builtin.fields
          if (!src.jsonPath && builtin.jsonPath) src.jsonPath = builtin.jsonPath
          if (!src.entryRegex && builtin.entryRegex) src.entryRegex = builtin.entryRegex
        }
      }
      if (!src.format) src.format = 'json'
      return src
    })
  return out.length ? out : DEFAULT_MARKET_SOURCES.map((s) => ({ ...s }))
}

// ---------------- 最小 HTTP GET（跟随重定向 + 超时 + 响应体上限） ----------------
function httpGetText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 20000
    const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 5
    const maxBytes = opts.maxBytes != null ? opts.maxBytes : 32 * 1024 * 1024 // 默认 32MB
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
        let total = 0
        res.on('data', (c) => {
          total += c.length
          if (total > maxBytes) {
            req.destroy(new Error('response too large (' + total + ' bytes > ' + maxBytes + ')'))
            return
          }
          chunks.push(c)
        })
        res.on('error', () => reject(new Error('response stream error')))
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
// 标准字段：任何源都映射到统一输出（pkg/name/description/version/category/homepage）。
// 扩展字段：fields 中其它任意键 → 进 packaged.meta（可按 numeric/boolean 标注类型），
// 供渲染层按 source.defaultSort 等通用逻辑使用，不绑定任何特定市场。
const STANDARD_KEYS = ['name', 'description', 'version', 'category', 'homepage', 'pkg']

function buildCommon(out, source) {
  // 无显式 pkg 时回退用 name（自定义 catalog JSON 源无 install 字段时的兜底）
  if (!out.pkg && out.name) out.pkg = out.name
  if (!out.pkg) return null
  if (!out.name) out.name = out.pkg
  const built = { id: out.id || out.pkg, name: out.name, description: out.description || '', version: out.version || '', category: out.category || '', homepage: out.homepage || '', pkg: out.pkg, source: source.name || '' }
  if (out.meta && Object.keys(out.meta).length) built.meta = out.meta
  return built
}

// 通用扩展字段提取：任意 key -> 原值（按 spec.numeric/boolean 做类型标注）
// rawReader: (spec) => 原始值 | null —— json 源取路径原始值（保类型），html 源返回字符串
function extractExtras(fields, entry, rawReader) {
  const meta = {}
  for (const key of Object.keys(fields)) {
    if (STANDARD_KEYS.includes(key)) continue
    const spec = fields[key]
    let raw = null
    try {
      raw = rawReader(spec)
    } catch (_) { raw = null }
    if (raw == null || raw === '') continue
    if (spec && typeof spec === 'object' && spec.numeric) {
      const n = Number(raw)
      meta[key] = Number.isNaN(n) ? null : n
    } else if (spec && typeof spec === 'object' && spec.boolean) {
      meta[key] = raw === true || raw === 'true' || raw === 1
    } else if (Array.isArray(raw)) {
      meta[key] = raw.map(String)
    } else {
      meta[key] = String(raw)
    }
  }
  return Object.keys(meta).length ? meta : null
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
      for (const key of STANDARD_KEYS) {
        out[key] = fields[key] != null ? resolveJsonField(fields[key], entry) : (entry[key] != null ? String(entry[key]) : '')
      }
      out.meta = extractExtras(fields, entry, (spec) => {
        // 扩展字段原始值：string='路径'、{json}=路径原值、数组=取首个非空、{const}=常量
        if (typeof spec === 'string') return pickPath(entry, spec)
        if (Array.isArray(spec)) {
          for (const cand of spec) {
            const v = typeof cand === 'string' ? pickPath(entry, cand) : (cand && cand.json != null ? pickPath(entry, cand.json) : null)
            if (v != null && v !== '') return v
          }
          return null
        }
        if (spec && typeof spec === 'object') {
          if (spec.const != null) return spec.const
          if (spec.json != null) return pickPath(entry, Array.isArray(spec.json) ? spec.json[0] : spec.json)
        }
        return null
      })
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
// 生成 pnpm/node 垫片，使打包后的 Electron（自带 Node）可在无系统 Node/pnpm 时安装插件。
// shimDir 必须是可写目录（如 userData/shims）；electronPath 用 process.execPath，pnpmCliPath 指向打包的 pnpm。
function buildPnpmShims(shimDir, electronPath, pnpmCliPath) {
  require('fs').mkdirSync(shimDir, { recursive: true })
  const e = JSON.stringify(electronPath)
  const c = JSON.stringify(pnpmCliPath)
  const nodeShim = '#!/bin/sh\n exec ' + e + ' --expose-internals "$@"\n'
  const pnpmShim = '#!/bin/sh\n DIR="$(cd "$(dirname "$0")" && pwd)"\n exec "$DIR/node" ' + c + ' "$@"\n'
  const fs = require('fs')
  const nodePath = require('path').join(shimDir, 'node')
  const pnpmPath = require('path').join(shimDir, 'pnpm')
  fs.writeFileSync(nodePath, nodeShim, { mode: 0o755 })
  fs.writeFileSync(pnpmPath, pnpmShim, { mode: 0o755 })
  return shimDir
}

// 安装用的环境变量：把垫片目录前置到 PATH，并锁定为国内公开源（淘宝 npmmirror）。
function pnpmEnv(shimDir, homeDir, registry) {
  const reg = registry || 'https://registry.npmmirror.com'
  return {
    PATH: shimDir + require('path').delimiter + (process.env.PATH || ''),
    ELECTRON_RUN_AS_NODE: '1',
    HOME: homeDir,
    npm_config_registry: reg,
    // 市场 profile 是 pnpm workspace 根，向其直接添加依赖需放开该限制
    npm_config_ignore_workspace_root_check: 'true',
  }
}

async function runDshPlugin(binPath, homeDir, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-internals', binPath, 'plugin', '--profile', 'web', ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: homeDir, ...extraEnv },
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

async function listInstalledPlugins(binPath, homeDir, extraEnv = {}) {
  const r = await runDshPlugin(binPath, homeDir, ['ls'], extraEnv)
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

// 直接使用内置 pnpm 运行命令（绕过 dsh CLI，避免参数解析问题）
// pnpmBin: pnpm.cjs 路径，profileDir: ~/.dsh/profiles/web
async function runPnpm(pnpmBin, profileDir, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-internals', pnpmBin, ...args], {
      cwd: profileDir,
      env: { ...process.env, ...extraEnv },
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

// 使用 pnpm ls --json 列出已安装的插件（解析 JSON 输出，更可靠）
async function pnpmListPlugins(pnpmBin, profileDir, extraEnv = {}) {
  const r = await runPnpm(pnpmBin, profileDir, ['ls', '--json', '--depth', '0'], extraEnv)
  if (r.code !== 0) return []
  try {
    const parsed = JSON.parse(r.log)
    if (!Array.isArray(parsed)) return []
    const result = []
    for (const entry of parsed) {
      if (entry.dependencies && typeof entry.dependencies === 'object') {
        for (const [name, dep] of Object.entries(entry.dependencies)) {
          result.push({ name, version: dep.version || '' })
        }
      }
    }
    return result
  } catch (_) {
    return []
  }
}

module.exports = {
  DEFAULT_MARKET_SOURCES,
  normalizeMarketSources,
  httpGetText,
  browseMarket,
  parseJsonSource,
  parseHtmlSource,
  buildPnpmShims,
  pnpmEnv,
  runDshPlugin,
  listInstalledPlugins,
  runPnpm,
  pnpmListPlugins,
}
