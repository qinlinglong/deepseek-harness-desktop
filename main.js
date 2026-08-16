const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  shell,
  ipcMain,
  nativeImage,
  clipboard,
  screen,
  dialog,
} = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const os = require('node:os')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const httpProxy = require('http-proxy')
const yaml = require('js-yaml')
// 原生 macOS 悬浮球置顶（koffi + AppKit，豆包同款）。非 macOS 或 koffi
// 缺失时 nativeFloatTop 为 null，reapplyFloatTop 自动回退 Electron API。
let nativeFloatTop = null
try {
  nativeFloatTop = require('./scripts/native-float.js')
} catch (_) {}

const isMac = process.platform === 'darwin'
const APP_TITLE = 'DeepSeek Harness'
// 悬浮球窗口层级：用 'pop-up-menu'（NSPopUpMenuWindowLevel=101），足够高于
// 普通/最大化窗口(0)，且配合 FullScreenAuxiliary 能出现在全屏 Space。
// 不用 'status'(25)：实测在 macOS 全屏 Space 下偶发被剔除，导致浏览器/IDEA
// 全屏下悬浮球不可见。不用 'screen-saver'(1000)：太高被系统级窗口过滤。
const FLOAT_LEVEL = 'pop-up-menu'
const dshVersion = require('@deepseek-ai/dsh/package.json').version
const PASSWORD_SALT = 'dsh-desktop:'

const DEFAULT_CONFIG = {
  mode: 'local', // 'local' | 'lan' | 'remote'
  lanPort: 3080,
  passwordHash: '',
  remoteHost: '',
  remotePort: 3080,
  remoteScheme: 'http', // 'http' | 'https'
  icon: 'deepseek', // 'deepseek' | 'dnee'
  showFloat: true,
  bubblePos: null,
}

const MAX_SERVER_ATTEMPTS = 5
const SERVER_READY_TIMEOUT_MS = 20000

const ICON_FILES = {
  deepseek: 'deepseek.png',
  dnee: 'dnee.png',
}

// CSS injected into the mini chat webview to show only the conversation column
const MINI_CSS = `
[data-slot="sidebar"] { display: none !important; }
[data-slot="details"] { display: none !important; }
[class$="_frame"] { grid-template-columns: 0px 1fr 0px !important; }
`

let mainWindow = null
let tray = null
let floatWin = null
let miniWin = null
let miniPinned = true
let floatGrab = null
let serverProc = null
let serverPort = null
let serverStarting = false
let isQuitting = false
let currentOrigin = null
let authProxy = null // { server, proxy }
let bootGen = 0
let reachableLanIps = []
let config = { ...DEFAULT_CONFIG }

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Windows：设置 AppUserModelID，保证任务栏/托盘图标与通知正常显示
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.deepseek.harness.desktop')
  }
  app.on('second-instance', () => restoreWindow())
  app.whenReady().then(onReady)
}

// ---------------- config ----------------

function configFile() {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8')
    config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch (_) {
    config = { ...DEFAULT_CONFIG }
  }
  // 规范化，防止损坏/旧版本配置导致主进程异常（如 lanPort 非数字触发 listen 崩溃）
  config.mode = config.mode === 'lan' || config.mode === 'remote' ? config.mode : 'local'
  config.lanPort = clampInt(config.lanPort, 1024, 65535, DEFAULT_CONFIG.lanPort)
  config.remotePort = clampInt(config.remotePort, 1, 65535, DEFAULT_CONFIG.remotePort)
  config.remoteScheme = config.remoteScheme === 'https' ? 'https' : 'http'
  config.remoteHost = String(config.remoteHost || '').replace(/^https?:\/\//, '')
  if (config.icon === 'gemini') config.icon = 'dnee'
  if (config.icon === 'default' || !ICON_FILES[config.icon]) config.icon = 'deepseek'
  if (typeof config.showFloat !== 'boolean') config.showFloat = true
  log('main', `config: mode=${config.mode} lanPort=${config.lanPort} hasPassword=${!!config.passwordHash} remote=${config.remoteHost || ''}:${config.remotePort}`)
}

function saveConfigToDisk() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch (e) {
    log('main', `failed to save config: ${e.message}`)
  }
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(PASSWORD_SALT + pw).digest('hex')
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function lanIPv4s() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address) out.push(iface.address)
    }
  }
  return [...new Set(out)]
}

// ---------------- icons ----------------

function iconPath(name) {
  const file = ICON_FILES[name] || ICON_FILES.deepseek
  return path.join(__dirname, 'assets', 'icons', file)
}

function applyIcon() {
  const p = iconPath(config.icon)
  let img
  try {
    img = nativeImage.createFromPath(p)
  } catch (_) {
    return
  }
  if (img.isEmpty()) return
  try {
    if (tray) tray.setImage(img.resize({ width: 18, height: 18 }))
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(img)
    if (isMac && app.dock) app.dock.setIcon(img)
    sendFloatIcon()
  } catch (e) {
    log('main', `applyIcon: ${e.message}`)
  }
}

// ---------------- utils ----------------

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${String(msg).trimEnd()}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dshBinPath() {
  let p = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked')
  }
  return p
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

function pickPort() {
  return 40000 + Math.floor(Math.random() * 20000)
}

/** 从 start 起找一个空闲端口（被占用则递增），返回实际可用端口。 */
function findFreePort(start, tries = 200) {
  return new Promise((resolve) => {
    let p = start
    const attempt = () => {
      if (tries-- <= 0) return resolve(start)
      const srv = net.createServer()
      srv.once('error', () => {
        try { srv.close() } catch (_) {}
        p++
        attempt()
      })
      srv.listen(p, '127.0.0.1', () => {
        const ok = srv.address().port
        try { srv.close() } catch (_) {}
        resolve(ok)
      })
    }
    attempt()
  })
}

/** 探测某个本机 IP 的局域网端口是否真正可访问（接口可达性）。 */
function probeHost(ip, port, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: '/', timeout }, (r) => {
      r.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      try { req.destroy() } catch (_) {}
      resolve(false)
    })
  })
}

/** 找出当前实际可访问的局域网 IP（过滤未连接/不可达的网卡）。 */
async function reachableLanIpsFor(port) {
  const ips = lanIPv4s()
  const good = []
  for (const ip of ips) {
    if (await probeHost(ip, port)) good.push(ip)
  }
  return good
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:status', status)
  }
}

let harnessLoadTries = 0

function loadInWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  harnessLoadTries = 0
  try {
    currentOrigin = new URL(url).origin
  } catch (_) {}
  mainWindow.loadURL(url)
}

function isAllowedOrigin(url) {
  let u
  try {
    u = new URL(url)
  } catch (_) {
    return false
  }
  if (currentOrigin && u.origin === currentOrigin) return true
  const host = u.hostname
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

// ---------------- dsh server ----------------

function ensureDarkTheme() {
  try {
    const dir = path.join(app.getPath('home'), '.dsh')
    const file = path.join(dir, 'settings.yaml')
    const data = fs.existsSync(file) ? (yaml.load(fs.readFileSync(file, 'utf8')) || {}) : {}
    const ui = data['ui-theme']
    if (!ui || !ui.preference) {
      data['ui-theme'] = { ...(ui || {}), preference: 'dark' }
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, yaml.dump(data), 'utf8')
      log('main', 'defaulted ui-theme preference to dark')
    }
  } catch (e) {
    log('main', `ensureDarkTheme: ${e.message}`)
  }
}

function spawnServer(port) {
  const bin = dshBinPath()
  const cwd = app.getPath('home')
  const args = ['--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', String(port)]
  for (const ip of lanIPv4s()) args.push('--trusted-host', ip)
  log('main', `spawn dsh ${dshVersion} at http://127.0.0.1:${port} (cwd=${cwd}) trustedHosts=${lanIPv4s().join(',')}`)
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  // Spawn-level failure (e.g. packaged bin path not found): treat as an
  // immediate exit so waitReady fails fast and the retry loop can move on.
  child.on('error', (err) => {
    log('main', `dsh server spawn error: ${err.message} (port=${port})`)
    try {
      child.emit('exit', -1, null)
    } catch (_) {}
  })
  child.stdout.on('data', (d) => log('dsh', d.toString()))
  child.stderr.on('data', (d) => log('dsh', d.toString()))
  child.on('exit', (code, signal) => {
    log('main', `dsh server exited code=${code} signal=${signal} (port=${port})`)
    if (!isQuitting && serverProc === child) {
      serverProc = null
      serverPort = null
      // 服务已死：局域网代理指向的端口随即失效，停止代理避免返回 Bad Gateway
      stopAuthProxy()
      sendStatus({ state: 'error', message: `服务意外退出 (code=${code})` })
      // 主窗口若停留在已死的服务页，回退到启动页展示错误，避免"死页面"
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.getURL().includes('index.html')) {
        try { mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')) } catch (_) {}
      }
    }
  })
  return child
}

function stopServer() {
  const child = serverProc
  if (!child) {
    serverPort = null
    return
  }
  serverProc = null
  serverPort = null
  log('main', 'stopping dsh server')
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 8000 })
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch (_) {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (_) {}
      }, 2500).unref()
    }
  } catch (e) {
    try {
      child.kill('SIGKILL')
    } catch (_) {}
  }
}

function waitReady(port, child, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(async () => {
      if (serverProc !== child || child.exitCode !== null) {
        clearInterval(timer)
        resolve(false)
        return
      }
      if (await probe(port)) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() > deadline) {
        clearInterval(timer)
        resolve(false)
      }
    }, 600)
    timer.unref()
  })
}

// ---------------- LAN auth proxy ----------------

function isLoopbackAddr(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

function timingSafeEqualHex(a, b) {
  try {
    const ba = Buffer.from(a, 'hex')
    const bb = Buffer.from(b, 'hex')
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
  } catch (_) {
    return false
  }
}

function hasValidCookie(req) {
  const cookies = String(req.headers.cookie || '').split(';')
  for (const c of cookies) {
    const idx = c.indexOf('dsh_session=')
    if (idx >= 0) {
      const token = c.slice(idx + 'dsh_session='.length).trim()
      if (loginSessions.has(token) && loginSessions.get(token) > Date.now()) return true
    }
  }
  return false
}

// 一次性随机会话 token（不把密码哈希当令牌），支持限流
const loginSessions = new Map() // token -> expiresAt(ms)
const loginFailures = new Map() // ip -> { count, until }
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000
const MAX_LOGIN_FAILURES = 5
const LOGIN_LOCK_MS = 5 * 60 * 1000

function isLoginLocked(req) {
  const ip = req.socket.remoteAddress || ''
  const rec = loginFailures.get(ip)
  if (!rec) return false
  // 仅锁定期内拦截；锁定过期才清理。计数未达阈值时保留累计，
  // 否则会把累积中的失败计数也清掉，导致限流永远触发不了。
  if (rec.until > Date.now()) return true
  if (rec.until > 0) loginFailures.delete(ip)
  return false
}

function noteLoginFailure(req) {
  const ip = req.socket.remoteAddress || ''
  const rec = loginFailures.get(ip) || { count: 0, until: 0 }
  rec.count++
  if (rec.count >= MAX_LOGIN_FAILURES) rec.until = Date.now() + LOGIN_LOCK_MS
  loginFailures.set(ip, rec)
}

function loginPage(err) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>登录 · DeepSeek Harness</title>
<style>
  :root { color-scheme: dark; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:radial-gradient(1000px 700px at 50% 0%, #141830 0%, #0b0d16 55%);
    color:#e6e9f5; height:100vh; display:flex; align-items:center; justify-content:center;
  }
  .card { width:340px; text-align:center; }
  .logo { width:56px; height:56px; margin:0 auto 18px; border-radius:14px;
    background:linear-gradient(135deg,#7d98ff,#4d6bfe); display:flex; align-items:center; justify-content:center;
    color:#fff; font-weight:700; font-size:22px; }
  h1 { font-size:17px; font-weight:600; }
  .sub { font-size:12px; color:#8a93b5; margin:6px 0 22px; }
  input { width:100%; padding:11px 12px; border-radius:8px; border:1px solid #2a3050;
    background:#101423; color:#e6e9f5; font-size:14px; outline:none; }
  input:focus { border-color:#4d6bfe; }
  button { width:100%; margin-top:12px; padding:11px; border:0; border-radius:8px;
    background:#4d6bfe; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { background:#5b78ff; }
  .err { margin-top:12px; font-size:12px; color:#ff8a8a; min-height:16px; }
  .tip { margin-top:18px; font-size:11px; color:#5b6484; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">D</div>
    <h1>DeepSeek Harness</h1>
    <div class="sub">此服务需要密码访问</div>
    <form method="post" action="/_auth/login">
      <input type="password" name="password" placeholder="访问密码" autofocus autocomplete="current-password"/>
      <button type="submit">登录</button>
    </form>
    <div class="err">${err || ''}</div>
    <div class="tip">由 DeepSeek Harness 桌面版提供</div>
  </div>
</body>
</html>`
}

function handleLogin(req, res) {
  if (isLoginLocked(req)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(loginPage('尝试次数过多，请稍后再试'))
    return
  }
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 8192) {
      res.writeHead(413)
      res.end()
      req.destroy()
    }
  })
  req.on('error', () => res.destroy())
  req.on('end', () => {
    let pw = ''
    try {
      pw = new URLSearchParams(body).get('password') || ''
    } catch (_) {}
    if (config.passwordHash && timingSafeEqualHex(hashPassword(pw), config.passwordHash)) {
      const token = crypto.randomBytes(32).toString('hex')
      loginSessions.set(token, Date.now() + SESSION_TTL_MS)
      loginFailures.delete(req.socket.remoteAddress || '')
      res.writeHead(302, {
        'set-cookie': `dsh_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        location: '/',
      })
      res.end()
      return
    }
    noteLoginFailure(req)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(loginPage('密码错误，请重试'))
  })
}

function handleLogout(res) {
  res.writeHead(302, { 'set-cookie': 'dsh_session=; Path=/; Max-Age=0', location: '/' })
  res.end()
}

// crypto.randomUUID 仅在安全上下文(HTTPS/localhost)可用；局域网 HTTP 访问
// 是非安全上下文，需要 polyfill，否则 dsh 前端报 "crypto.randomUUID is not a function"。
const RANDOM_UUID_POLYFILL = '(function(){var C=window.crypto;if(C&&!C.randomUUID){C.randomUUID=function(){var b=new Uint8Array(16);C.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="0123456789abcdef",s="";for(var i=0;i<16;i++){s+=h[b[i]>>4]+h[b[i]&15];if(i===3||i===5||i===7||i===9){s+="-"}}return s}}})();'

function injectRandomUUIDPolyfill(html) {
  if (!html || html.includes('dsh-rng-polyfill')) return html
  const tag = '<script>/*dsh-rng-polyfill*/' + RANDOM_UUID_POLYFILL + '<' + '/script>'
  if (html.includes('</head>')) return html.replace('</head>', tag + '</head>')
  if (html.includes('</html>')) return html.replace('</html>', tag + '</html>')
  return html + tag
}

function startAuthProxy(lanPort, targetPort) {
  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${targetPort}`,
    ws: true,
    // 局域网访问时，dsh 的 /api 浏览器信任围栏只认 loopback/trusted-host 的
    // Host 与同源 Origin。这里统一改写为 loopback 身份，避免 trusted-host
    // 链路失效导致局域网用户 /api 全部 403。
    changeOrigin: true,
  })
  proxy.on('error', (err, _req, res) => {
    log('main', `proxy web error: ${err.message}`)
    try {
      if (res && !res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>服务暂不可用</title></head>' +
          '<body style="font-family:system-ui;background:#0b0d16;color:#dbe2f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
          '<div style="text-align:center"><h1 style="font-size:26px;margin:0 0 10px">服务暂不可用</h1>' +
          '<p style="margin:0;color:#8a93a8">Agent 服务当前未运行或正在重启，请稍后刷新页面。</p>' +
          '<p style="margin:10px 0 0;font-size:13px;color:#5d6577">若长时间无法访问，请在桌面应用设置中重新开启局域网服务。</p></div></body></html>'
        )
      }
    } catch (_) {}
  })
  proxy.on('wsError', (_err, _req, socket) => {
    try {
      socket.destroy()
    } catch (_) {}
  })
  // 把 Origin 一并改写为 loopback，保证 fence 的 same-origin 校验通过
  proxy.on('proxyReq', (proxyReq, req) => {
    if (req.headers.origin) proxyReq.setHeader('origin', `http://127.0.0.1:${targetPort}`)
  })
  proxy.on('proxyReqWs', (proxyReq, req) => {
    if (req.headers.origin) proxyReq.setHeader('origin', `http://127.0.0.1:${targetPort}`)
  })
  // 给通过代理访问的 HTML 注入 crypto.randomUUID polyfill（修复局域网 IP 访问报错）
  proxy.on('proxyRes', (proxyRes, _req, res) => {
    const ct = String(proxyRes.headers['content-type'] || '')
    const ce = String(proxyRes.headers['content-encoding'] || '')
    if (!ct.includes('text/html') || (ce && ce !== 'identity')) return
    const chunks = []
    proxyRes.on('data', (c) => chunks.push(c))
    proxyRes.on('end', () => {
      try {
        const html = injectRandomUUIDPolyfill(Buffer.concat(chunks).toString('utf8'))
        const headers = { ...proxyRes.headers }
        delete headers['content-length']
        if (!res.headersSent) res.writeHead(proxyRes.statusCode, headers)
        res.end(html)
      } catch (_) {}
    })
  })

  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/_auth/')) {
      if (req.url === '/_auth/login' && req.method === 'POST') return handleLogin(req, res)
      if (req.url === '/_auth/logout') return handleLogout(res)
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    if (!hasValidCookie(req)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage())
      return
    }
    proxy.web(req, res)
  })

  server.on('upgrade', (req, socket, head) => {
    if (!hasValidCookie(req)) {
      try {
        if (socket.writable) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        }
        socket.destroy()
      } catch (_) {}
      return
    }
    proxy.ws(req, socket, head)
  })

  server.on('error', (err) => {
    log('main', `LAN proxy error: ${err.message}`)
    if (err.code === 'EADDRINUSE') {
      sendStatus({ state: 'error', message: `局域网端口 ${lanPort} 已被占用，请在设置中更换端口` })
    } else {
      sendStatus({ state: 'error', message: `局域网服务启动失败: ${err.message}` })
    }
  })

  server.listen(lanPort, '0.0.0.0', () => {
    log('main', `LAN proxy listening on 0.0.0.0:${lanPort} -> 127.0.0.1:${targetPort}`)
  })
  authProxy = { server, proxy }
}

function stopAuthProxy() {
  if (authProxy) {
    try {
      authProxy.server.close()
    } catch (_) {}
    try {
      authProxy.proxy.close()
    } catch (_) {}
    authProxy = null
  }
}

// ---------------- mode orchestration ----------------

async function startServerWithRetry(gen) {
  for (let attempt = 1; attempt <= MAX_SERVER_ATTEMPTS; attempt++) {
    const port = pickPort()
    const child = spawnServer(port)
    serverProc = child
    serverPort = port

    const ready = await waitReady(port, child, SERVER_READY_TIMEOUT_MS)
    if (gen !== bootGen) {
      // A newer applyConfig() took over: it already stopped this child and
      // owns the server lifecycle. Leave it alone.
      return null
    }
    if (ready) {
      log('main', `server ready at http://127.0.0.1:${port} (attempt ${attempt})`)
      return { port, child }
    }
    log('main', `server failed on port ${port} (attempt ${attempt}/${MAX_SERVER_ATTEMPTS})`)
    stopServer()
    await sleep(300)
  }
  return null
}

async function applyConfig() {
  const gen = ++bootGen
  stopServer()
  stopAuthProxy()
  // 与桌面端深色 UI 统一：未显式设置主题时，让 dsh 主窗口默认深色
  ensureDarkTheme()
  sendStatus({ state: 'booting', mode: config.mode })

  if (config.mode === 'remote') {
    const host = config.remoteHost || '127.0.0.1'
    const scheme = config.remoteScheme === 'https' ? 'https' : 'http'
    const url = `${scheme}://${host}:${config.remotePort}/`
    log('main', `remote mode -> ${url}`)
    sendStatus({ state: 'ready', message: '已连接远程服务', url, mode: 'remote' })
    loadInWindow(url)
    sendMiniUrl()
    return true
  }

  if (config.mode === 'lan' && !config.passwordHash) {
    sendStatus({ state: 'error', message: '局域网服务端必须设置访问密码' })
    return false
  }

  const started = await startServerWithRetry(gen)
  if (gen !== bootGen) {
    // A newer applyConfig() owns the lifecycle now; do not touch its server.
    return false
  }
  if (!started) {
    stopServer()
    const winHint = process.platform === 'win32'
      ? ' 若已安装 Git for Windows（Git Bash）仍失败，请从命令行启动应用并开启日志查看具体原因（设置环境变量 ELECTRON_ENABLE_LOGGING=1）。'
      : ''
    sendStatus({ state: 'error', message: `本地服务启动失败，已重试 ${MAX_SERVER_ATTEMPTS} 次。${winHint}` })
    return false
  }
  const port = started.port

  if (config.mode === 'lan') {
    // 端口被占用时自动顺延一个空闲端口，并持久化，保证局域网可访问
    const actualPort = await findFreePort(config.lanPort)
    if (actualPort !== config.lanPort) {
      config.lanPort = actualPort
      saveConfigToDisk()
      log('main', `lan port ${actualPort} in use -> switched to ${config.lanPort}`)
    }
    startAuthProxy(actualPort, port)
    // 只保留真实可达的局域网 IP（排除未连接的网卡，如 192.168.255.10 之类超时接口）
    await sleep(300)
    reachableLanIps = await reachableLanIpsFor(actualPort)
    const lanIps = reachableLanIps.length ? reachableLanIps : lanIPv4s()
    const lanUrl = `http://${lanIps[0] || '127.0.0.1'}:${actualPort}/`
    sendStatus({
      state: 'ready',
      message: '局域网服务已开启',
      url: `http://127.0.0.1:${port}/`,
      mode: 'lan',
      lanUrl,
      lanIps,
    })
  } else {
    sendStatus({ state: 'ready', message: '就绪', url: `http://127.0.0.1:${port}/`, mode: 'local' })
  }
  loadInWindow(`http://127.0.0.1:${port}/`)
  sendMiniUrl()
  return true
}

// ---------------- window / tray ----------------

function restoreWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 用户正在设置页时只聚焦，不跳转（避免丢失未保存的表单）
  if (mainWindow.webContents.getURL().includes('index.html')) return
  const url = currentWebUrl()
  if (url) {
    try {
      mainWindow.webContents.loadURL(url)
    } catch (_) {}
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: APP_TITLE,
    show: false,
    backgroundColor: '#0b0d16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 主界面（远程/本机 harness）加载失败：服务已就绪时先重试（启动初期可能尚未监听），
  // 最终失败再回退设置页并显示错误，避免白屏或停留在"正在启动"转圈
  mainWindow.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!isMainFrame) return
    if (url.startsWith('file://')) return
    if (mainWindow.webContents.getURL().includes('index.html')) return
    const target = currentWebUrl()
    if (target && target === url && harnessLoadTries < 3) {
      harnessLoadTries++
      log('main', `harness load failed (${code}), retry ${harnessLoadTries}/3: ${url}`)
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && currentWebUrl() === target) {
          try { mainWindow.webContents.loadURL(target) } catch (_) {}
        }
      }, 800)
      return
    }
    log('main', `load failed (${code}) ${url} ${desc} -> fallback to settings page`)
    sendStatus({ state: 'error', message: '主界面加载失败，请检查服务后重试', mode: config.mode })
    try { mainWindow.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html')) } catch (_) {}
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      return { action: 'deny' }
    }
    openExternalSafe(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedOrigin(url)) {
      e.preventDefault()
      openExternalSafe(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function remoteUrl() {
  const host = config.remoteHost || '127.0.0.1'
  const scheme = config.remoteScheme === 'https' ? 'https' : 'http'
  return `${scheme}://${host}:${config.remotePort}/`
}

function openBrowserUrl() {
  if (config.mode === 'remote') {
    openExternalSafe(remoteUrl())
  } else if (config.mode === 'lan' && serverPort) {
    const first = lanAccessUrls().split('\n')[0]
    if (first) openExternalSafe(first)
  } else if (serverPort) {
    openExternalSafe(`http://127.0.0.1:${serverPort}/`)
  }
}

function buildAppMenu() {
  const template = [
    {
      label: APP_TITLE,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CommandOrControl+,', click: () => showSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  let icon
  try {
    icon = nativeImage.createFromPath(iconPath(config.icon)).resize({ width: 18, height: 18 })
  } catch (_) {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip(APP_TITLE)
  const menu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => restoreWindow() },
    { label: '打开迷你聊天', click: () => toggleMini() },
    {
      label: config.showFloat ? '隐藏悬浮球' : '显示悬浮球',
      click: () => {
        toggleFloat()
        createTray()
      },
    },
    { label: '设置', click: () => showSettings() },
    { type: 'separator' },
    { label: '在浏览器中打开', click: () => openBrowserUrl() },
    {
      label: '复制局域网地址',
      enabled: config.mode === 'lan',
      click: () => {
        const ips = lanIPv4s()
        clipboard.writeText(`http://${ips[0] || '127.0.0.1'}:${config.lanPort}/`)
      },
    },
    { type: 'separator' },
    { label: '重启服务', click: () => applyConfig() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => restoreWindow())
}

function showSettings(preMode) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return
  const wc = mainWindow.webContents
  const send = () => {
    if (!wc.isDestroyed()) wc.send('dsh:show-settings', preMode)
  }
  // 若已停留在设置页则直接显示；否则先回到设置页，加载完成后再显示
  if (wc.getURL().includes('index.html')) {
    send()
  } else {
    wc.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    wc.once('did-finish-load', send)
  }
}

const ICON_LABELS = { deepseek: 'DeepSeek 官方', dnee: 'D娘' }

function openExternalSafe(url) {
  // 仅放行 http/https，避免 file:/smb:/自定义协议等被滥用
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href)
  } catch (_) {}
}

function lanAccessUrls() {
  const ips = reachableLanIps.length ? reachableLanIps : lanIPv4s()
  return ips.length
    ? ips.map((ip) => `http://${ip}:${config.lanPort}`).join('\n')
    : '未检测到局域网 IP'
}

async function switchMode(mode) {
  if (mode === 'remote') {
    // 局域网连接：先跳转到填写 IP/端口的设置页（复用连接设置），保存后自动连接
    config.mode = 'remote'
    saveConfigToDisk()
    showSettings('remote')
    return
  }
  if (mode === 'lan') {
    if (!config.passwordHash) {
      dialog.showMessageBox({
        type: 'warning',
        title: '局域网服务端',
        message: '开启局域网服务前需先设置访问密码',
        detail: '为防止局域网内他人随意操作本机 Agent，请先在「打开设置」中为局域网服务端设置访问密码。',
        buttons: ['取消', '前往设置'],
        defaultId: 1,
        cancelId: 0,
      }).then(({ response }) => {
        if (response === 1) showSettings('lan')
      })
      return
    }
    config.mode = 'lan'
    saveConfigToDisk()
    const started = await applyConfig()
    if (!started) {
      dialog.showMessageBox({
        type: 'error',
        title: '局域网服务端启动失败',
        message: '无法启动局域网服务',
        detail: '请检查端口是否被占用，或在设置页重新保存后重试。',
        buttons: ['知道了'],
      })
      return
    }
    const urls = lanAccessUrls().split('\n').filter(Boolean)
    dialog.showMessageBox({
      type: 'info',
      title: '局域网服务端已开启',
      message: `访问地址：\n${urls.join('\n')}`,
      detail: '使用方法：\n· 浏览器：局域网内任意设备打开上方地址，首次访问输入密码。\n· 本应用：其他设备选「局域网连接」模式，填入本机 IP 和端口。\n上方仅列出当前可访问的局域网 IP；若全部无法访问，请检查系统防火墙是否允许本应用接收网络连接。',
      buttons: ['取消', '确定开启'],
      defaultId: 1,
      cancelId: 0,
    }).then(({ response }) => {
      if (response === 1 && urls[0]) {
        openExternalSafe(urls[0])
      }
    })
    return
  }
  config.mode = mode
  saveConfigToDisk()
  await applyConfig()
}

function setIcon(name) {
  if (!ICON_FILES[name]) return
  config.icon = name
  saveConfigToDisk()
  applyIcon()
}

function showFloatMenu() {
  if (!floatWin || floatWin.isDestroyed()) return
  const menu = Menu.buildFromTemplate([
    {
      label: '应用图标',
      submenu: Object.keys(ICON_FILES).map((name) => ({
        label: ICON_LABELS[name] || name,
        type: 'radio',
        checked: config.icon === name,
        click: () => setIcon(name),
      })),
    },
    { type: 'separator' },
    {
      label: '连接方式',
      submenu: [
        { label: '本机模式', type: 'radio', checked: config.mode === 'local', click: () => switchMode('local') },
        { label: '局域网连接', type: 'radio', checked: config.mode === 'remote', click: () => switchMode('remote') },
        { label: '局域网服务端', type: 'radio', checked: config.mode === 'lan', click: () => switchMode('lan') },
      ],
    },
    { type: 'separator' },
    {
      label: '置顶',
      type: 'checkbox',
      checked: floatWin._floatOnTop !== false,
      click: (item) => {
        if (floatWin && !floatWin.isDestroyed()) {
          if (item.checked) {
            floatWin._floatOnTop = true
            reapplyFloatTop()
          } else {
            floatWin._floatOnTop = false
            // 取消置顶：还原 Electron 默认 level 并关 visibleOnAllWorkspaces
            if (nativeFloatTop && process.platform === 'darwin') {
              // 原生已控制 level，取消时让 Electron 接管 setAlwaysOnTop(false)
              floatWin.setAlwaysOnTop(false)
            } else {
              floatWin.setAlwaysOnTop(false)
            }
            floatWin.setVisibleOnAllWorkspaces(false)
          }
        }
      },
    },
    { type: 'separator' },
    { label: '打开设置', click: () => showSettings() },
    { type: 'separator' },
    { label: '退出应用', click: () => { isQuitting = true; app.quit() } },
  ])
  menu.popup({ window: floatWin })
}

// ---------------- floating bubble & mini chat ----------------

function currentWebUrl() {
  if (config.mode === 'remote') {
    return remoteUrl()
  }
  return serverPort ? `http://127.0.0.1:${serverPort}/` : null
}

// 从设置页「取消」返回主界面（当前模式的 harness / 远程页面），避免停留在启动转圈页
function backToMainUI() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const url = currentWebUrl()
  if (url) {
    loadInWindow(url)
    return
  }
  try { mainWindow.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html')) } catch (_) {}
}

function sendFloatIcon() {
  if (!floatWin || floatWin.isDestroyed()) return
  try {
    const img = nativeImage.createFromPath(iconPath(config.icon)).resize({ width: 48, height: 48 })
    if (!img.isEmpty()) floatWin.webContents.send('float:icon', img.toDataURL())
  } catch (_) {}
}

function positionFloatDefault() {
  if (!floatWin || floatWin.isDestroyed()) return
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay().workArea
  const [w, h] = floatWin.getSize()
  floatWin.setPosition(display.x + display.width - w - 24, display.y + display.height - h - 24)
}

// 统一重申悬浮球置顶与跨工作区显示。
// 普通全屏/最大化场景不涉及多 Space，只需确保 alwaysOnTop 生效；
// moveTop 用于窗口被其他应用覆盖时强制回到最前（透明窗口偶发不重绘）。
// macOS 上优先用原生 AppKit 设置（豆包同款），Electron 高层 API 兜底。
// macOS 上优先用原生 AppKit 设置 collectionBehavior（visibleOnFullScreen 等），
// Electron 的 setAlwaysOnTop 负责 window level。这样两者不冲突：
// - Electron 管理 level（避免被其事件重置）
// - native 管理 collectionBehavior（Electron API 在 macOS Sonoma+ 偶发不生效）
function reapplyFloatTop() {
  if (!floatWin || floatWin.isDestroyed()) return
  if (floatWin._floatOnTop === false) return
  try {
    // Electron 管理 level（用 pop-up-menu = 101，介于 status 和 screen-saver 之间，
    // 足够高以高于所有普通/最大化窗口，且配合 FullScreenAuxiliary 能在全屏 Space 显示）
    floatWin.setAlwaysOnTop(true, FLOAT_LEVEL)
    floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    // native 补充 collectionBehavior（确保含 CanJoinAllSpaces + FullScreenAuxiliary +
    // Stationary + IgnoresCycle = 281），Electron 的 setVisibleOnAllWorkspaces 在
    // macOS Sonoma+ 偶发不全设这些位
    if (nativeFloatTop) {
      nativeFloatTop.applyNativeFloatTop(floatWin)
    }
  } catch (_) {}
}

// macOS 全屏（如浏览器全屏、IDE 全屏）会把应用放进独立 Space，悬浮球窗口
// 若未持续声明 visibleOnFullScreen 集合行为，就不会出现在该 Space（表现为
// "全屏下悬浮球消失"）。blur 事件在进入全屏时不一定触发，因此：
//   1) 用节流轮询持续重应用集合行为（setter 幂等，1.5s 一次开销极小）；
//   2) 监听 display-metrics-changed（macOS 全屏进出会隐藏菜单栏/Dock，
//      改变显示器可用区域），触发时立即重应用并回到最前。
let floatTopWatch = null

function startFloatTopWatch() {
  stopFloatTopWatch()
  floatTopWatch = setInterval(() => {
    if (!floatWin || floatWin.isDestroyed()) return
    if (floatWin._floatOnTop !== false) reapplyFloatTop()
  }, 1500)
  if (floatTopWatch.unref) floatTopWatch.unref()
}

function stopFloatTopWatch() {
  if (floatTopWatch) {
    clearInterval(floatTopWatch)
    floatTopWatch = null
  }
}

// 透明窗口被其他应用（尤其最大化/全屏）覆盖后，macOS 偶发不重绘导致"图标消失"。
// forceRefresh 重绘方案：用 setOpacity(0.99→1) 触发透明窗口重绘，而非 hide+show。
// 关键修正1：showInactive() 在 macOS 上不提升 z-order，会导致悬浮球被最大化
//   窗口(level 0)盖住——这就是"最大化下悬浮球不置顶"的根因之一。
// 关键修正2：forceRefresh 不能调用 setAlwaysOnTop('status')——Electron 的
//   setAlwaysOnTop 只支持预设 level，会把原生 setLevel(27) 重置为 status(25)，
//   破坏豆包同款 27 级置顶。改用 applyNativeFloatTop 重新设置原生 level。
// lastFloatRefresh 防抖：600ms 内只允许一次强制重绘，阻断循环。
let lastFloatRefresh = 0

function floatToFront(forceRefresh) {
  if (!floatWin || floatWin.isDestroyed()) return
  try {
    reapplyFloatTop()
    floatWin.moveTop()
    if (forceRefresh) {
      const now = Date.now()
      if (now - lastFloatRefresh < 600) return
      lastFloatRefresh = now
      // setOpacity 微小变化触发重绘，不 hide/show、不抢焦点、不丢失 z-order
      floatWin.setOpacity(0.99)
      setTimeout(() => {
        if (!floatWin || floatWin.isDestroyed()) return
        try {
          floatWin.setOpacity(1)
          // 重新应用原生 level=27（不能调 Electron setAlwaysOnTop 否则覆盖）
          if (nativeFloatTop) nativeFloatTop.applyNativeFloatTop(floatWin)
          floatWin.moveTop()
        } catch (_) {}
      }, 30)
    }
  } catch (_) {}
}

function createFloatWindow() {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.show()
    return
  }
  floatWin = new BrowserWindow({
    width: 48,
    height: 48,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'floating-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  floatWin.loadFile(path.join(__dirname, 'renderer', 'floating.html'))
  floatWin._floatOnTop = true
  reapplyFloatTop()
  startFloatTopWatch()
  floatWin.once('ready-to-show', () => floatWin.show())
  floatWin.once('did-finish-load', () => sendFloatIcon())
  floatWin.on('show', () => {
    reapplyFloatTop()
    sendFloatIcon()
  })
  // 应用切换/全屏后可能被覆盖或透明不重绘，强制刷新回到最前（限频 500ms）
  floatWin.on('focus', () => floatToFront(false))
  floatWin.on('blur', () => {
    clearTimeout(floatWin._toFront)
    floatWin._toFront = setTimeout(() => {
      if (floatWin && !floatWin.isDestroyed()) floatToFront(true)
    }, 250)
    if (floatWin._toFront.unref) floatWin._toFront.unref()
  })

  if (Array.isArray(config.bubblePos) && config.bubblePos.length === 2) {
    floatWin.setPosition(config.bubblePos[0], config.bubblePos[1])
  } else {
    positionFloatDefault()
  }

  let saveTimer = null
  floatWin.on('move', () => {
    if (!floatWin) return
    config.bubblePos = floatWin.getPosition()
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveConfigToDisk(), 600)
    saveTimer.unref && saveTimer.unref()
  })

  floatWin.on('closed', () => {
    stopFloatTopWatch()
    floatWin = null
  })
}

function toggleFloat() {
  config.showFloat = !config.showFloat
  saveConfigToDisk()
  if (config.showFloat) {
    if (!floatWin || floatWin.isDestroyed()) createFloatWindow()
    else floatWin.show()
  } else if (floatWin) {
    floatWin.hide()
  }
}

function createMiniWindow() {
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.show()
    miniWin.focus()
    return
  }
  miniWin = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 320,
    minHeight: 480,
    frame: false,
    show: false,
    alwaysOnTop: miniPinned,
    backgroundColor: '#0b0d16',
    title: APP_TITLE,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'mini-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })
  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'))
  miniWin.once('ready-to-show', () => miniWin.show())
  miniWin.on('closed', () => {
    miniWin = null
  })
  miniWin.webContents.on('did-attach-webview', (_e, guest) => {
    let cssKey = null
    guest.on('dom-ready', () => {
      // 每次导航先移除旧的注入样式，避免重复累积
      if (cssKey) guest.removeInsertedCSS(cssKey).catch(() => {})
      guest.insertCSS(MINI_CSS).then((k) => { cssKey = k }).catch(() => {})
    })
  })
  miniWin.webContents.once('did-finish-load', () => {
    miniWin.webContents.send('mini:pin', miniPinned)
    sendMiniUrl()
  })
}

function sendMiniUrl() {
  if (!miniWin || miniWin.isDestroyed()) return
  const url = currentWebUrl()
  if (url) miniWin.webContents.send('mini:url', url)
}

function toggleMini() {
  if (!miniWin || miniWin.isDestroyed()) {
    createMiniWindow()
  } else if (miniWin.isVisible()) {
    miniWin.hide()
  } else {
    miniWin.show()
    miniWin.focus()
    sendMiniUrl()
  }
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.on('dsh:restart', () => applyConfig())
  ipcMain.on('dsh:back', () => backToMainUI())

  ipcMain.on('float:drag-start', () => {
    if (!floatWin || floatWin.isDestroyed()) return
    const pt = screen.getCursorScreenPoint()
    const [wx, wy] = floatWin.getPosition()
    floatGrab = { ox: pt.x - wx, oy: pt.y - wy }
    // 拖动开始即刷新防抖：拖动期间 + 拖动后 600ms 内禁止 forceRefresh
    // 的 hide+show 重绘，否则 pointerup 后悬浮球 blur 触发重绘会让窗口闪一下
    lastFloatRefresh = Date.now()
  })
  ipcMain.on('float:drag-move', () => {
    if (!floatWin || floatWin.isDestroyed() || !floatGrab) return
    const pt = screen.getCursorScreenPoint()
    floatWin.setPosition(Math.round(pt.x - floatGrab.ox), Math.round(pt.y - floatGrab.oy))
    // 拖动过程中持续刷新防抖，避免 1.5s 轮询的 reapply 与高频 setPosition 叠加造成闪烁
    lastFloatRefresh = Date.now()
  })
  ipcMain.on('float:drag-end', () => {
    floatGrab = null
    // 拖动结束刷新防抖：阻断 pointerup 后 blur 触发的 forceRefresh 重绘
    lastFloatRefresh = Date.now()
  })
  ipcMain.on('float:toggle-mini', () => toggleMini())
  ipcMain.on('float:menu', () => showFloatMenu())
  ipcMain.on('float:quit', () => {
    isQuitting = true
    app.quit()
  })

  ipcMain.on('dsh:quit', () => {
    isQuitting = true
    app.quit()
  })

  ipcMain.on('mini:open-main', () => {
    if (miniWin && !miniWin.isDestroyed()) miniWin.hide()
    restoreWindow()
  })
  ipcMain.on('mini:toggle-pin', () => {
    miniPinned = !miniPinned
    if (miniWin && !miniWin.isDestroyed()) {
      miniWin.setAlwaysOnTop(miniPinned)
      miniWin.webContents.send('mini:pin', miniPinned)
    }
  })
  ipcMain.on('mini:minimize', () => {
    if (miniWin && !miniWin.isDestroyed()) miniWin.hide()
  })

  ipcMain.handle('dsh:version', () => ({ app: app.getVersion(), dsh: dshVersion }))

  ipcMain.handle('dsh:get-icons', () => {
    const out = {}
    for (const name of Object.keys(ICON_FILES)) {
      try {
        out[name] = nativeImage.createFromPath(iconPath(name)).resize({ width: 64, height: 64 }).toDataURL()
      } catch (_) {}
    }
    return out
  })

  ipcMain.handle('dsh:get-config', () => ({
    mode: config.mode,
    lanPort: config.lanPort,
    remoteHost: config.remoteHost,
    remotePort: config.remotePort,
    remoteScheme: config.remoteScheme,
    hasPassword: !!config.passwordHash,
    lanIps: lanIPv4s(),
    icon: config.icon,
    showFloat: config.showFloat,
  }))

  ipcMain.handle('dsh:save-config', (_e, cfg) => {
    const mode = cfg && (cfg.mode === 'lan' || cfg.mode === 'remote') ? cfg.mode : 'local'
    config.mode = mode
    config.lanPort = clampInt(cfg && cfg.lanPort, 1024, 65535, 3080)
    config.remotePort = clampInt(cfg && cfg.remotePort, 1, 65535, 3080)
    config.remoteHost = String((cfg && cfg.remoteHost) || '').trim().replace(/^https?:\/\//, '')
    config.remoteScheme = cfg && cfg.remoteScheme === 'https' ? 'https' : 'http'
    if (ICON_FILES[cfg && cfg.icon]) config.icon = cfg.icon
    if (cfg && typeof cfg.showFloat === 'boolean') config.showFloat = cfg.showFloat
    if (mode === 'lan' && !config.passwordHash && !(cfg && cfg.password && String(cfg.password).trim())) {
      return { ok: false, error: '局域网服务端必须设置访问密码' }
    }
    if (cfg && cfg.password && String(cfg.password).trim()) {
      config.passwordHash = hashPassword(String(cfg.password))
    }
    saveConfigToDisk()
    applyIcon()
    applyFloatState()
    applyConfig()
    return { ok: true }
  })
}

function applyFloatState() {
  if (config.showFloat) {
    if (!floatWin || floatWin.isDestroyed()) createFloatWindow()
    else floatWin.show()
  } else if (floatWin && !floatWin.isDestroyed()) {
    floatWin.hide()
  }
}

// ---------------- app lifecycle ----------------

async function onReady() {
  loadConfig()
  buildAppMenu()
  createWindow()
  createTray()
  applyIcon()
  registerIpc()
  applyFloatState()
  registerScreenMetricsListener()
  applyConfig()
}

app.on('before-quit', () => {
  isQuitting = true
  stopServer()
  stopAuthProxy()
})

app.on('window-all-closed', () => {
  if (!isQuitting) return
  app.quit()
})

// 切到其他应用（含其全屏 space）时重申悬浮球置顶，确保不被遮挡
app.on('browser-window-blur', () => {
  clearTimeout(reapplyFloatTop._timer)
  reapplyFloatTop._timer = setTimeout(() => {
    if (floatWin && !floatWin.isDestroyed()) floatToFront(true)
  }, 250)
  if (reapplyFloatTop._timer.unref) reapplyFloatTop._timer.unref()
})

// macOS 进入/退出全屏会改变显示器可用区域（隐藏/恢复菜单栏与 Dock），
// 触发 display-metrics-changed：立即重申悬浮球集合行为并回到最前，
// 保证全屏 Space 下悬浮球可见（不依赖 blur 事件）。
// 注意：screen 模块只能在 app ready 后使用，故在 onReady() 内注册。
function registerScreenMetricsListener() {
  screen.on('display-metrics-changed', () => {
    if (floatWin && !floatWin.isDestroyed() && floatWin.isAlwaysOnTop()) {
      reapplyFloatTop()
      floatWin.moveTop()
    }
  })
}

app.on('activate', () => restoreWindow())
