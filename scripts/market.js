// 插件市场源适配器 + 安装执行器（抽出独立模块便于单测）。
// 支持三类市场源：
//   dshmarket  → 标准 JSON 目录（{plugins:[{name,description,install,tags,homepage}]}）
//   awesome    → 整页 HTML，安装命令在 data-cmd="dsh plugin --profile web add <pkg>"
//   catalog    → 任意 JSON 目录（数组 / {plugins} / {packages}）
'use strict'
const https = require('https')
const http = require('http')
const { spawn } = require('node:child_process')

const DEFAULT_MARKET_SOURCES = [
  { id: 'dshmarket', name: 'dsh.market', type: 'dshmarket', url: 'https://dsh.market/plugins.json' },
  { id: 'awesome', name: 'awesome-dsh-plugin.com', type: 'awesome', url: 'https://awesome-dsh-plugin.com/' },
]

function normalizeMarketSources(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_MARKET_SOURCES.map((s) => ({ ...s }))
  const out = arr
    .filter((s) => s && s.url && s.type)
    .map((s, i) => ({
      id: String(s.id || 'src-' + i + '-' + Date.now()),
      name: String(s.name || s.url).slice(0, 60),
      type: ['dshmarket', 'awesome', 'catalog'].includes(s.type) ? s.type : 'catalog',
      url: String(s.url).trim(),
    }))
  return out.length ? out : DEFAULT_MARKET_SOURCES.map((s) => ({ ...s }))
}

// 最小 HTTP GET（跟随重定向 + 超时）
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

function normalizeDshMarket(body) {
  let data
  try { data = typeof body === 'string' ? JSON.parse(body) : body } catch (_) { data = {} }
  const plugins = Array.isArray(data) ? data : (data.plugins || [])
  return plugins
    .map((p, i) => {
      let pkg = ''
      const cmd = p.install && (p.install.command || (Array.isArray(p.install.commands) && p.install.commands[0]))
      if (cmd) {
        const mm = String(cmd).match(/add\s+([^\s"]+)/)
        if (mm) pkg = mm[1]
      }
      if (!pkg) pkg = p.name || p.fullName || p.id || ''
      return {
        id: p.id || p.name || ('p' + i),
        name: p.name || p.id || '未命名插件',
        description: p.description || p.descriptionZh || '',
        version: p.version || '',
        category: Array.isArray(p.tags) ? p.tags.slice(0, 3).join(', ') : '',
        homepage: p.homepage || p.repository || '',
        pkg,
        source: 'dsh.market',
      }
    })
    .filter((p) => p.pkg)
}

function extractAttrAround(html, idx, attr) {
  const start = Math.max(0, idx - 800)
  const end = Math.min(html.length, idx + 120)
  const seg = html.slice(start, end)
  const m = seg.match(new RegExp(attr + '="([^"]*)"'))
  return m ? m[1] : ''
}
function normalizeAwesome(html) {
  const re = /data-cmd="[^"]*dsh\s+plugin\s+--profile\s+web\s+add\s+([^"\s@]+)/g
  const seen = new Set()
  const out = []
  let m
  while ((m = re.exec(html))) {
    const pkg = m[1]
    if (seen.has(pkg)) continue
    seen.add(pkg)
    const name = extractAttrAround(html, m.index, 'name') || pkg.replace(/^@[^/]+\//, '')
    const cat = extractAttrAround(html, m.index, 'data-cat')
    const desc = extractAttrAround(html, m.index, 'data-desc') || extractAttrAround(html, m.index, 'title')
    out.push({
      id: pkg,
      name,
      description: desc,
      version: '',
      category: cat,
      homepage: '',
      pkg,
      source: 'awesome-dsh-plugin.com',
    })
  }
  return out
}

function normalizeCatalog(body) {
  let data
  try { data = typeof body === 'string' ? JSON.parse(body) : body } catch (_) { data = {} }
  let list = []
  if (Array.isArray(data)) list = data
  else if (Array.isArray(data.plugins)) list = data.plugins
  else if (Array.isArray(data.packages)) list = data.packages
  return list
    .map((p, i) => ({
      id: p.id || p.name || ('c' + i),
      name: p.name || p.title || p.id || '未命名插件',
      description: p.description || p.desc || '',
      version: p.version || '',
      category: Array.isArray(p.category) ? p.category.join(', ') : (p.category || (p.tags ? p.tags.join(', ') : '')),
      homepage: p.homepage || p.repository || p.repo || '',
      pkg: p.package || p.install || p.source || p.name || '',
      source: 'catalog',
    }))
    .filter((p) => p.pkg)
}

async function browseMarket(source) {
  const { status, body } = await httpGetText(source.url, { timeout: 25000 })
  if (status !== 200) throw new Error('市场源加载失败 (HTTP ' + status + ')')
  if (source.type === 'dshmarket') return normalizeDshMarket(body)
  if (source.type === 'awesome') return normalizeAwesome(body)
  return normalizeCatalog(body)
}

// 执行 dsh plugin --profile web <add|remove> <pkg>（转发 pnpm），捕获日志
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
  normalizeDshMarket,
  normalizeAwesome,
  normalizeCatalog,
  browseMarket,
  runDshPlugin,
  listInstalledPlugins,
}
