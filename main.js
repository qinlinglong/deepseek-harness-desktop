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
  globalShortcut,
} = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
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
const market = require('./scripts/market.js')
const APP_TITLE = 'DeepSeek Harness'
// 悬浮球窗口层级：用 'pop-up-menu'（NSPopUpMenuWindowLevel=101），足够高于
// 普通/最大化窗口(0)。macOS 上由 native-float.js 原生覆盖为 level=27（豆包实测值）。
// 不用 'screen-saver'(1000)：太高被系统级窗口过滤。
const FLOAT_LEVEL = 'pop-up-menu'
const dshVersion = require('@deepseek-ai/dsh/package.json').version
const PASSWORD_SALT = 'dsh-desktop:'

// 登录页头像：DeepSeek 官方图标转 data URL 内嵌，避免登录页依赖外部资源
let loginLogoDataUrl = ''
function getLoginLogoDataUrl() {
  if (loginLogoDataUrl) return loginLogoDataUrl
  try {
    const p = path.join(__dirname, 'assets', 'icons', 'deepseek.png')
    if (fs.existsSync(p)) {
      const buf = fs.readFileSync(p)
      loginLogoDataUrl = 'data:image/png;base64,' + buf.toString('base64')
    }
  } catch (_) {}
  return loginLogoDataUrl || ''
}

// 插件市场源（可自由更换的市场源，桌面端内置预设，用户可增删/切换）。
// type 决定解析适配器：'dshmarket'=标准 plugins.json；'awesome'=HTML data-cmd；'catalog'=任意 JSON 目录。
const DEFAULT_MARKET_SOURCES = [
  { id: 'dshmarket', name: 'dsh.market', type: 'dshmarket', url: 'https://dsh.market/plugins.json' },
  { id: 'awesome', name: 'awesome-dsh-plugin.com', type: 'awesome', url: 'https://awesome-dsh-plugin.com/' },
]

const DEFAULT_CONFIG = {
  mode: 'local', // 'local' | 'lan' | 'remote'
  lanPort: 3080,
  passwordHash: '',
  remoteHost: '',
  remotePort: 3080,
  remoteScheme: 'http', // 'http' | 'https'
  remotePassword: '', // 远端桌面 lan 服务的访问密码（用于 /_auth/login 拿 cookie 调 /desktop/*）
  icon: 'deepseek', // 'deepseek' | 'dnee'
  showFloat: true,
  bubblePos: null,
  mainBounds: null, // {x,y,width,height} 主窗口位置尺寸，启动时恢复（借鉴豆包 chat_window 持久化）
  miniBounds: null,  // {width,height} 迷你窗尺寸
  marketSources: DEFAULT_MARKET_SOURCES, // 插件市场源（预设 + 用户自定义）
}

const MAX_SERVER_ATTEMPTS = 3
const SERVER_READY_TIMEOUT_MS = 12000
const PICK_PORT_MIN = 40000
const PICK_PORT_RANGE = 20000
const SIGKILL_TIMEOUT_MS = 2500
const DEBOUNCE_MS = 600
const STALE_WAIT_MS = 800
const PROXY_TIMEOUT_MS = 60000
const PROBE_TIMEOUT_MS = 1200
const FLOAT_FORCE_REFRESH_INTERVAL_MS = 600
const READY_POLL_INTERVAL_MS = 600
const WARMUP_DELAY_MS = 800

const ICON_FILES = {
  deepseek: 'deepseek.png',
  dnee: 'dnee.png',
}

// CSS injected into the mini chat webview to show only the conversation column
// rc.8 布局：sidebar/details 需置 none，且外层 grid（class 后缀 _frame）仍保留第一列
// 56px（~42pt 空白条），必须把左右列压为 0 —— 否则迷你窗左侧出现无意义竖条。
const MINI_CSS = `
[data-slot="sidebar"] { display: none !important; }
[data-slot="details"] { display: none !important; }
[class$="_frame"] { grid-template-columns: 0px 1fr 0px !important; }
`

let mainWindow = null
let tray = null
let trayMenu = null // 托盘右键菜单，供副屏"菜单栏图标"复用
// 副屏幕上的"菜单栏图标"窗口：macOS 菜单栏 StatusItem 只显示在主显示器，
// 为对齐豆包（每屏状态栏都有入口），给每个非主屏各建一个贴顶小图标窗口。
const menuBarWins = new Map() // displayId -> BrowserWindow
let floatWin = null
let miniWin = null
let miniPinned = true
let floatGrab = null
let serverProc = null
let serverPort = null
// remote 模式是否成功加载过目标页面：backToMainUI 未成功过则不再硬连
// （避免回到一个从未可达的地址，卡在"正在启动服务"）
let remoteConnectedOnce = false
// 从设置页保存局域网服务端后，ready 时弹出地址框（不跳转 dsh 界面）
let pendingLanAddressModal = false
let isQuitting = false
let lastMainWindowUrl = '' // 主窗口关闭前的 URL，用于重建时决定跳转目标
let currentOrigin = null
let authProxy = null // { server, proxy }
let bootGen = 0
let reachableLanIps = []
let lastDshErr = '' // 最近一次 dsh 服务进程的 stderr（用于启动失败时回显报错）
// remote 模式下远端桌面服务的能力与登录态（供插件远程安装路由使用）
let remoteCapable = false // 远端是否为桌面版服务（暴露 /desktop/* 端点）
let remoteCapableAuthError = false // 远端是桌面版但密码错误
let cachedRemoteCookie = '' // 远端 /_auth/login 拿到的会话 cookie
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
  config.remotePassword = String(config.remotePassword || '')
  if (config.icon === 'gemini') config.icon = 'dnee'
  if (config.icon === 'default' || !ICON_FILES[config.icon]) config.icon = 'deepseek'
  if (typeof config.showFloat !== 'boolean') config.showFloat = true
  config.marketSources = normalizeMarketSources(config.marketSources)
  log('main', `config: mode=${config.mode} lanPort=${config.lanPort} hasPassword=${!!config.passwordHash} remote=${sanitizeLog((config.remoteHost || '') + ':' + config.remotePort)}`)
}

function saveConfigToDisk() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch (e) {
    log('main', `failed to save config: ${e.message}`)
  }
}

// 密码哈希：scrypt KDF（自带随机盐 + 高计算成本，抗离线爆破）。
// 存储格式 scrypt$N$r$p$salt$hash；旧版 SHA-256 格式由 verifyPassword 兼容。
const SCRYPT_COST = 16384 // N
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pw, salt, 32, { N: SCRYPT_COST, r: 8, p: 1 })
  return `scrypt$${SCRYPT_COST}$8$1$${salt}$${hash.toString('hex')}`
}

// 兼容旧版：SHA-256(静态盐 + 密码)
function hashPasswordLegacy(pw) {
  return crypto.createHash('sha256').update(PASSWORD_SALT + pw).digest('hex')
}

function verifyPassword(pw, stored) {
  if (!stored) return false
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    try {
      const [, N, r, p, salt, hash] = stored.split('$')
      const calc = crypto.scryptSync(pw, salt, 32, { N: Number(N), r: Number(r), p: Number(p) })
      return timingSafeEqualHex(calc.toString('hex'), hash)
    } catch (_) {
      return false
    }
  }
  // 旧版 SHA-256 哈希兼容（登录成功后提示重设密码）
  return timingSafeEqualHex(hashPasswordLegacy(pw), stored)
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

// ---------------- 快捷指令 / 提词器 ----------------

const DEFAULT_PROMPTS = [
  { id: 'p-summarize', name: '总结全文', content: '请用中文简洁总结这段内容，提炼关键要点与结论。' },
  { id: 'p-explain', name: '解释代码', content: '请详细解释以下代码/内容的作用、执行流程与关键细节。' },
  { id: 'p-refactor', name: '优化重构', content: '请审查这段内容，给出优化建议并输出重构后的版本。' },
  { id: 'p-fix', name: '修复 Bug', content: '请定位并修复其中的问题，解释根因，输出修改后的完整代码。' },
  { id: 'p-translate', name: '翻译成中文', content: '请将以下内容翻译成通顺的中文，保留专业术语。' },
]

function promptsFile() {
  return path.join(app.getPath('userData'), 'prompts.json')
}

let promptsCache = null
function normalPrompts(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((p) => p && p.name && p.content)
    .map((p, i) => ({
      id: String(p.id || 'p' + i + '-' + Date.now()),
      name: String(p.name).slice(0, 50),
      content: String(p.content),
    }))
}
function loadPrompts() {
  if (promptsCache) return promptsCache
  let arr = []
  try { arr = JSON.parse(fs.readFileSync(promptsFile(), 'utf8')) } catch (_) {}
  if (!Array.isArray(arr) || arr.length === 0) arr = DEFAULT_PROMPTS
  promptsCache = normalPrompts(arr)
  return promptsCache
}
function savePrompts(arr) {
  promptsCache = normalPrompts(arr)
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(promptsFile(), JSON.stringify(promptsCache, null, 2), { mode: 0o600 })
  } catch (e) {
    log('main', `savePrompts: ${e.message}`)
  }
  return promptsCache
}

// 往 dsh 页面输入框安全填入文本（React 受控组件需走原生 setter + input 事件）
function injectComposerText(webContents, text, opts = {}) {
  if (!webContents || webContents.isDestroyed()) return
  const json = JSON.stringify(String(text || ''))
  const newSession = opts.newSession !== false
  const js = `(() => {
    const fill = () => {
      const ta = document.querySelector('textarea:not([readonly])')
      if (!ta) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${json})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    if (${newSession}) {
      const b = document.querySelector('button[aria-label="新建会话"]')
      if (b) b.click()
    }
    if (fill()) return 'ok'
    let tries = 0
    return new Promise((res) => {
      const t = setInterval(() => { if (fill() || ++tries > 25) { clearInterval(t); res('ok') } }, 200)
      setTimeout(() => { clearInterval(t); res('ok') }, 6000)
    })
  })()`
  try { webContents.executeJavaScript(js).catch(() => {}) } catch (_) {}
}

// 划词唤起：把选中文本作为新会话提问（弥合全局快捷键只能"唤起"不能"带内容"的缺口，
// 对齐豆包"划词即问"——在主窗/迷你窗的 dsh 页面里右键选中文案即可触发）
function askWithSelection(text) {
  const sel = String(text || '').trim()
  if (!sel) return
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
  // 等待主窗加载到目标页（dsh 界面）后填入
  const tryInject = () => {
    const url = (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) ? mainWindow.webContents.getURL() : ''
    if (/^https?:\/\//.test(url) || /index\.html/.test(url)) {
      injectComposerText(mainWindow.webContents, sel, { newSession: true })
      return true
    }
    if (tryInject._t++ > 40) return true
    setTimeout(tryInject, 250)
    return false
  }
  tryInject._t = 0
  tryInject()
}

function setupSelectionAsk(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  webContents.on('context-menu', (_e, params) => {
    const sel = (params.selectionText || '').trim()
    if (!sel) return
    const label = sel.length > 26 ? sel.slice(0, 26) + '…' : sel
    const menu = Menu.buildFromTemplate([
      {
        label: `用 DeepSeek 提问：${label}`,
        click: () => askWithSelection(sel),
      },
    ])
    try { menu.popup() } catch (_) {}
  })
}

function runPromptFast(text) {
  const sel = String(text || '')
  if (!miniWin || miniWin.isDestroyed()) createMiniWindow(true)
  else {
    reapplyMiniTop()
    miniWin.show()
    miniWin.focus()
  }
  // 渲染端在 view 就绪后注入并填入
  try { miniWin.webContents.send('mini:run-prompt', sel) } catch (_) {}
}

// ---------------- 插件市场 ----------------
// 实现见 scripts/market.js（可单测）。这里只承接主进程调用。

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
    refreshMenuBarIcons()
  } catch (e) {
    log('main', `applyIcon: ${e.message}`)
  }
}

// ---------------- utils ----------------

let logStream = null
function log(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${String(msg).trimEnd()}`
  console.log(line)
  try {
    if (!logStream) {
      const dir = path.join(app.getPath('userData'), 'logs')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'dsh-desktop.log')
      logStream = fs.createWriteStream(file, { flags: 'a' })
      logStream.on('error', () => { logStream = null })
    }
    if (logStream) logStream.write(line + '\n')
  } catch (_) {}
}

// 全局兜底：主进程未捕获的 rejection/异常不能静默崩溃应用（Electron 20+ 会退出）
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason)
  log('main', `unhandledRejection: ${msg}`)
})
process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err)
  log('main', `uncaughtException: ${msg}`)
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 日志脱敏：隐藏可能出现的密钥/令牌/URL 凭据（dsh 是 Agent，输出可能含敏感信息）
function sanitizeLog(text) {
  if (!text) return text
  return String(text)
    // 词边界避免误伤 ask-for-help / risk-manager 等普通词
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/(authorization:\s*)[^\s;]+/gi, '$1***')
    .replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@') // URL 中的 user:pass@（含 :）
    .replace(/dsh_session=[A-Za-z0-9]+/g, 'dsh_session=***')
}

function dshBinPath() {
  let p = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (p.includes('app.asar')) {
    p = p.replace('app.asar', 'app.asar.unpacked')
  }
  return p
}

// 打包内 pnpm 的 cli 路径（asarUnpack 后落在 app.asar.unpacked/node_modules/pnpm）
const PKG_REGISTRY = 'https://registry.npmmirror.com'
function pnpmCliPath() {
  let dir
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked'))) {
    dir = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pnpm')
  } else {
    dir = path.join(__dirname, 'node_modules', 'pnpm')
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.pnpm
  return path.join(dir, bin)
}

// 把打包内的 pnpm 复制到 userData 形成“全局”安装。
// 必须用全局布局：pnpm 一旦发现自己位于某项目的 node_modules 内，会试图 re-exec
// 该项目本地的 node_modules/pnpm，而干净机器上该路径不存在 → 安装崩溃。
function ensureGlobalPnpm() {
  const srcDir = path.dirname(pnpmCliPath()) // <app>/node_modules/pnpm
  const root = path.join(app.getPath('userData'), 'pnpm-global', 'node_modules')
  const dstDir = path.join(root, 'pnpm')
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(root, { recursive: true })
    fs.cpSync(srcDir, dstDir, { recursive: true })
  }
  return path.join(dstDir, 'bin', 'pnpm.cjs')
}

let _shimDir = null
function pluginEnv(homeDir) {
  if (!_shimDir) {
    _shimDir = path.join(app.getPath('userData'), 'shims')
    const pnpmBin = ensureGlobalPnpm()
    market.buildPnpmShims(_shimDir, process.execPath, pnpmBin)
  }
  return market.pnpmEnv(_shimDir, homeDir, PKG_REGISTRY)
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: PROBE_TIMEOUT_MS }, (res) => {
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
  return PICK_PORT_MIN + Math.floor(Math.random() * PICK_PORT_RANGE)
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
function probeHost(ip, port, timeout = PROBE_TIMEOUT_MS) {
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

let lastStatus = { state: 'booting', mode: 'local' }

function sendStatus(status) {
  // 记录最近一次状态：renderer 重载（backToMainUI 回退到 index.html 等）后
  // 通过 dsh:get-status 拉取真实状态，避免停在"正在启动服务…"占位
  lastStatus = { ...status, mode: (status && status.mode) || lastStatus.mode }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:status', status)
  }
}

let harnessLoadTries = 0

// 导航超时兜底：remote/harness 页面加载可能"挂起"（既不成功也不报错，
// 如 TCP 连接无响应），did-fail-load 不会触发，导致启动页永久停在
// "正在启动服务…"。12s 内未完成加载则强制回退设置页并报错。
let navTimeout = null
function clearNavTimeout() {
  if (navTimeout) { clearTimeout(navTimeout); navTimeout = null }
}
function scheduleNavTimeout(url) {
  clearNavTimeout()
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (!wc) return
  wc.once('did-finish-load', clearNavTimeout)
  navTimeout = setTimeout(() => {
    navTimeout = null
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.webContents.getURL().includes('index.html')) return
    if (!mainWindow.webContents.isLoading()) return
    try { mainWindow.webContents.stop() } catch (_) {}
    log('main', `nav timeout (12s) ${sanitizeLog(url)} -> fallback to settings page`)
    sendStatus({ state: 'error', message: `连接目标服务超时：${url}，请检查地址是否可达，或改回本机模式`, mode: config.mode })
    try { mainWindow.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html')) } catch (_) {}
  }, 12000)
  if (navTimeout.unref) navTimeout.unref()
}

function loadInWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  harnessLoadTries = 0
  try {
    currentOrigin = new URL(url).origin
  } catch (_) {}
  scheduleNavTimeout(url)
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
  // remote 模式加载的是不可信第三方页面：仅放行同源，绝不放行 loopback，
  // 防止第三方页面把主窗口重定向到本机任意服务（本地服务探测/UI 劫持）。
  if (config.mode === 'remote') return false
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
  const args = ['--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
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
  child.stdout.on('data', (d) => log('dsh', sanitizeLog(d.toString())))
  child.stderr.on('data', (d) => {
    const s = d.toString()
    lastDshErr = (lastDshErr + s).slice(-2048)
    log('dsh', sanitizeLog(s))
  })
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

async function stopServer() {
  const child = serverProc
  if (!child) {
    serverPort = null
    return
  }
  serverProc = null
  serverPort = null
  log('main', 'stopping dsh server')
  if (child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 8000 })
      return
    }
    // 等待旧进程完全退出再返回：否则新进程启动后与未退出的旧进程可能并发
    // 写同一个会话日志，造成 seq gap 损坏（corrupt session log: seq gap in
    // committed region），历史对话无法加载。
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (_) {}
    const killer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch (_) {}
    }, SIGKILL_TIMEOUT_MS)
    if (killer.unref) killer.unref()
    // race 兜底：极端情况下 exit 事件在监听器注册前已触发，超时后强制返回
    await Promise.race([exited, sleep(SIGKILL_TIMEOUT_MS)])
    clearTimeout(killer)
  } catch (e) {
    try {
      child.kill('SIGKILL')
    } catch (_) {}
  }
}

// 清理此前崩溃/强退残留的孤儿 dsh 服务进程。dsh 用 detached:true 启动，
// 不随 Electron 退出；主进程异常退出后残留的 dsh 会继续写会话日志，
// 下次启动新 dsh 时两者并发写同一日志 → seq gap 损坏历史对话。
// 仅在 startServerWithRetry 启动前调用，并等待残留进程退出。
async function killStaleDshProcesses() {
  if (process.platform === 'win32') return
  let stale = []
  try {
    const out = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    if (out.error || !out.stdout) return
    const myPid = process.pid
    const procs = new Map() // pid -> ppid
    for (const line of out.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = Number(m[1])
      const ppid = Number(m[2])
      procs.set(pid, ppid)
      if (pid === myPid) continue
      // 仅匹配本应用的 dsh 服务进程（web 模式）
      if (!m[3].includes('@deepseek-ai/dsh') || !m[3].includes('lib/bin.js') || !m[3].includes(' web ')) continue
      // 正在被我们管理的进程由 stopServer 处理，这里只清残留
      if (serverProc && serverProc.pid === pid) continue
      stale.push({ pid, ppid })
    }
    // 只清理"孤儿"：父进程已死（ppid 不存在）或被 init(1) 收养（原父进程崩溃，
    // Electron 崩溃残留的 dsh 会被 launchd 收养为 ppid=1）。
    // 用户手动在终端运行的 dsh 父进程（shell）仍活跃，不会被误杀。
    stale = stale.filter((s) => s.ppid === 1 || !procs.has(s.ppid))
  } catch (_) {
    return
  }
  if (stale.length === 0) return
  log('main', `stale dsh process found: ${stale.map((s) => s.pid).join(', ')}`)
  for (const s of stale) {
    try { process.kill(s.pid, 'SIGTERM') } catch (_) {}
  }
  // 等待 SIGTERM 优雅退出，800ms 后仍未消失的强杀
  await sleep(STALE_WAIT_MS)
  for (const s of stale) {
    try {
      process.kill(s.pid, 0) // 探测进程是否仍存在
      process.kill(s.pid, 'SIGKILL')
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
    }, READY_POLL_INTERVAL_MS)
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

// 定期清理过期会话/失败记录，防止 Map 无限增长（内存 DoS）
function pruneLoginState() {
  const now = Date.now()
  for (const [token, exp] of loginSessions) {
    if (exp <= now) loginSessions.delete(token)
  }
  for (const [ip, rec] of loginFailures) {
    if (rec.until > 0 && rec.until <= now) loginFailures.delete(ip)
  }
}
setInterval(pruneLoginState, 30 * 60 * 1000).unref() // 每 30 分钟

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
    overflow:hidden; }
  .logo img { width:100%; height:100%; object-fit:contain; }
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
    <div class="logo"><img src="${getLoginLogoDataUrl()}" alt="DeepSeek"/></div>
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
    if (config.passwordHash && verifyPassword(pw, config.passwordHash)) {
      // 旧版 SHA-256 哈希登录成功后自动升级为 scrypt（写回 config）
      if (!String(config.passwordHash).startsWith('scrypt$')) {
        config.passwordHash = hashPassword(pw)
        saveConfigToDisk()
        log('main', 'password hash upgraded to scrypt')
      }
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
    // 上游（dsh 服务）卡死时主动超时，避免 LAN socket 无限悬挂
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
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
    // 桌面专属端点：供 remote 模式客户端远程安装/管理插件（需登录）
    if (req.url && req.url.startsWith('/desktop/')) {
      if (!hasValidCookie(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }
      return handleDesktopApi(req, res)
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
    const { server, proxy } = authProxy
    try {
      // Node 18.2+：关闭所有存量 keep-alive 连接，避免悬挂 socket
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    } catch (_) {}
    try {
      server.close()
    } catch (_) {}
    try {
      proxy.close()
    } catch (_) {}
    authProxy = null
  }
}

// ---------------- mode orchestration ----------------

async function startServerWithRetry(gen) {
  // 先清理崩溃残留的孤儿 dsh 进程，避免新旧 dsh 并发写同一会话日志
  await killStaleDshProcesses()
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
    await stopServer()
    await sleep(300)
  }
  return null
}

async function applyConfig() {
  const gen = ++bootGen
  try {
  await stopServer()
  stopAuthProxy()
  // 与桌面端深色 UI 统一：未显式设置主题时，让 dsh 主窗口默认深色
  ensureDarkTheme()
  sendStatus({ state: 'booting', mode: config.mode })

  if (config.mode === 'remote') {
    const host = config.remoteHost || '127.0.0.1'
    const scheme = config.remoteScheme === 'https' ? 'https' : 'http'
    const url = `${scheme}://${host}:${config.remotePort}/`
    log('main', `remote mode -> ${sanitizeLog(url)}`)
    sendStatus({ state: 'ready', message: '已连接远程服务', url, mode: 'remote' })
    remoteConnectedOnce = false
    loadInWindow(url)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.once('did-finish-load', () => { remoteConnectedOnce = true })
    }
    sendMiniUrl()
    // 探测远端是否为桌面版服务（决定能否远程安装插件）
    detectRemoteCapability().catch((e) => log('main', 'detectRemoteCapability: ' + (e && e.message)))
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
    await stopServer()
    const errTail = lastDshErr.trim().split('\n').filter(Boolean).slice(-4).join('  |  ')
    const winHint = process.platform === 'win32'
      ? ' 若已安装 Git for Windows（Git Bash）仍失败，请从命令行启动应用并开启日志查看具体原因（设置环境变量 ELECTRON_ENABLE_LOGGING=1）。'
      : ''
    sendStatus({
      state: 'error',
      message: `本地服务启动失败，已重试 ${MAX_SERVER_ATTEMPTS} 次。${errTail ? 'dsh 报错：' + errTail : '常见原因：端口被占用、dsh 依赖损坏或被安全软件拦截。'}${winHint}`,
    })
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
    if (pendingLanAddressModal) {
      // 从设置页保存：弹出地址框展示 IP/端口，不跳转 dsh 界面（与"已配置后再次保存"行为一致）
      pendingLanAddressModal = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh:lan-address', { lanUrl, lanIps, lanPort: actualPort })
      }
    } else {
      loadInWindow(`http://127.0.0.1:${port}/`)
    }
  } else {
    sendStatus({ state: 'ready', message: '就绪', url: `http://127.0.0.1:${port}/`, mode: 'local' })
    loadInWindow(`http://127.0.0.1:${port}/`)
  }
  sendMiniUrl()
  return true
  } catch (e) {
    log('main', 'applyConfig threw: ' + ((e && e.stack) || e))
    sendStatus({ state: 'error', message: '启动异常：' + ((e && e.message) || e) })
    return false
  }
}

// ---------------- window / tray ----------------

function closeSettingsView() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    // 仅 index.html 页面监听了 dsh:close-settings；dsh 界面(remote/local http)无监听，无副作用
    mainWindow.webContents.send('dsh:close-settings')
  } catch (_) {}
}

function restoreWindow() {
  // 打开/恢复主窗口统一回到主界面：设置页是 SPA 视图，跨会话残留会让
  // 托盘/Dock 单击看到的是"设置页"而非主界面（用户反馈的单击显示设置）。
  closeSettingsView()
  const hadWindow = !!(mainWindow && !mainWindow.isDestroyed())
  if (!hadWindow) {
    createWindow()
  } else {
    // 最小化窗口需显式 restore 才能可靠恢复（show 对 minimized 窗口行为不完全一致）
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return

  // 窗口已存在：恢复原样——只 show+focus，不刷新不跳转。
  // 关键：不能再 loadURL(currentWebUrl())，否则会把 dsh harness 界面内的
  // 设置页/任意子路由刷回根路径（最小化后恢复丢失用户所在页面）。
  if (hadWindow) return

  // 新建窗口（窗口此前被关闭）：loadFile(index.html) 异步加载中，getURL 为空。
  // 等 index.html 加载完成后，若关闭前在设置页则保持设置页，否则跳转到主界面。
  const target = currentWebUrl()
  if (!target) return
  const wasSettings = lastMainWindowUrl.includes('index.html')
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (wasSettings) return
    try { mainWindow.webContents.loadURL(target) } catch (_) {}
  })
}

function createWindow() {
  // 借鉴豆包 chat_window/image_viewer_window 持久化：保存主窗口上次位置尺寸
  const saved = config.mainBounds && typeof config.mainBounds === 'object' ? config.mainBounds : null
  const b = saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)
    ? saved
    : { width: 1320, height: 860 }
  mainWindow = new BrowserWindow({
    width: b.width,
    height: b.height,
    minWidth: 960,
    minHeight: 640,
    ...(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
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
  setupSelectionAsk(mainWindow.webContents)
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // 主窗口位置/尺寸变化时持久化（防抖 600ms）
  let saveBoundsTimer = null
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    clearTimeout(saveBoundsTimer)
    saveBoundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        const bounds = mainWindow.getBounds()
        // 最小化/最大化不保存不正常尺寸
        if (bounds.width >= 960 && bounds.height >= 640) {
          config.mainBounds = bounds
          saveConfigToDisk()
        }
      } catch (_) {}
    }, DEBOUNCE_MS)
    if (saveBoundsTimer.unref) saveBoundsTimer.unref()
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  // 持久化 EOF

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
      }, WARMUP_DELAY_MS)
      return
    }
    log('main', `load failed (${code}) ${url} ${desc} -> fallback to settings page`)
    clearNavTimeout()
    sendStatus({ state: 'error', message: `无法连接目标服务 ${url}，请检查地址是否可达，或改回本机模式`, mode: config.mode })
    try { mainWindow.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html')) } catch (_) {}
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) {
      // 同源新窗口（如 dsh 前端 target=_blank/window.open）：在主窗口内导航，
      // 而不是静默 deny 导致点击无响应
      try { mainWindow.webContents.loadURL(url) } catch (_) {}
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

  mainWindow.on('close', () => {
    try { lastMainWindowUrl = mainWindow.webContents.getURL() } catch (_) {}
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

function remoteBaseUrl() {
  const host = config.remoteHost || '127.0.0.1'
  const scheme = config.remoteScheme === 'https' ? 'https' : 'http'
  return `${scheme}://${host}:${config.remotePort}`
}

// 对远端桌面 lan 服务发起一次 HTTP 请求（带可选会话 cookie），返回 {status, json, text}。
// timeoutMs：整体超时（含 TCP 连接），超时或出错时 resolve(null)。
function remoteRequest(method, path, { body, cookie, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const lib = config.remoteScheme === 'https' ? https : http
    const u = new URL(remoteBaseUrl() + path)
    const headers = {}
    if (cookie) headers.cookie = cookie
    if (body != null) {
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      headers['content-type'] = typeof body === 'string'
        ? 'application/x-www-form-urlencoded'
        : 'application/json'
      headers['content-length'] = buf.length
    }
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const req = lib.request(
      { method, hostname: u.hostname, port: u.port, path, headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          clearTimeout(timer)
          let json = null
          try { json = JSON.parse(data) } catch (_) {}
          done({ status: res.statusCode, headers: res.headers, json, text: data })
        })
      }
    )
    const timer = setTimeout(() => {
      try { req.destroy() } catch (_) {}
      done(null)
    }, timeoutMs || PROXY_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    req.on('error', () => { clearTimeout(timer); done(null) })
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

// 用远端密码登录桌面 lan 服务，返回 { ok, authFail, cookie }
async function loginRemoteDesktop() {
  const r = await remoteRequest('POST', '/_auth/login', {
    body: 'password=' + encodeURIComponent(config.remotePassword || ''),
  })
  if (!r) return { ok: false, authFail: false }
  const setCookie = r.headers && r.headers['set-cookie']
  if (setCookie && setCookie.length) {
    const m = String(setCookie[0]).match(/dsh_session=[^;]+/)
    if (m) return { ok: true, authFail: false, cookie: m[0] }
  }
  if (r.status === 401 || r.status === 403) return { ok: false, authFail: true }
  return { ok: false, authFail: false }
}

// 探测远端是否为桌面版服务（暴露 /desktop/info）。
// 结果写入 remoteCapable / remoteCapableAuthError / cachedRemoteCookie 并推送到渲染层。
// 判定流程（避免把"密码错误"误判为"裸服务"）：
//   1) 未带 cookie 探测 /desktop/info：桌面 lan 服务会返回 401 {error:'unauthorized'}；
//      裸 harness 返回 404/SPA 或 JSON 无该标记 → 判定为不可远程安装。
//   2) 确认是桌面服务后，再 /_auth/login 拿会话 cookie；无 cookie 视为密码错误。
async function detectRemoteCapability() {
  if (config.mode !== 'remote') {
    remoteCapable = false
    remoteCapableAuthError = false
    cachedRemoteCookie = ''
    return
  }
  const probe = await remoteRequest('GET', '/desktop/info', { timeoutMs: 5000 })
  const isDesktop = !!(probe && probe.status === 401 && probe.json && probe.json.error === 'unauthorized')
  if (!isDesktop) {
    remoteCapable = false
    remoteCapableAuthError = false
    cachedRemoteCookie = ''
    sendStatus({ mode: 'remote', remoteCapable: false, remoteCapableAuthError: false })
    return
  }
  const login = await loginRemoteDesktop()
  if (!login.ok) {
    remoteCapable = false
    remoteCapableAuthError = true
    cachedRemoteCookie = ''
    sendStatus({ mode: 'remote', remoteCapable: false, remoteCapableAuthError: true })
    return
  }
  cachedRemoteCookie = login.cookie
  remoteCapable = true
  remoteCapableAuthError = false
  sendStatus({ mode: 'remote', remoteCapable: true, remoteCapableAuthError: false })
}

// 桌面 lan 服务专属端点（需登录）：供 remote 模式客户端远程安装插件。
async function handleDesktopApi(req, res) {
  const url = (req.url || '/').split('?')[0]
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET' && url === '/desktop/info') {
    res.writeHead(200)
    res.end(JSON.stringify({ desktop: true, version: app.getVersion() }))
    return
  }
  if (req.method === 'POST' && url === '/desktop/plugin-install') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 8192) {
        res.writeHead(413)
        res.end(JSON.stringify({ ok: false, log: '请求体过大' }))
        req.destroy()
      }
    })
    req.on('end', async () => {
      let pkg = '', action = 'add'
      try { const o = JSON.parse(body); pkg = String(o.pkg || ''); action = o.action === 'remove' ? 'remove' : 'add' } catch (_) {}
      if (!pkg) { res.writeHead(400); res.end(JSON.stringify({ ok: false, log: '缺少包名' })); return }
      try {
        const r = await market.runDshPlugin(dshBinPath(), app.getPath('home'), [action, pkg], pluginEnv(app.getPath('home')))
        res.writeHead(200)
        res.end(JSON.stringify({ ok: r.code === 0, log: r.log }))
      } catch (e) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, log: String((e && e.message) || e) }))
      }
    })
    return
  }
  if (req.method === 'GET' && url === '/desktop/plugin-list') {
    try {
      const list = await market.listInstalledPlugins(dshBinPath(), app.getPath('home'), pluginEnv(app.getPath('home')))
      res.writeHead(200)
      res.end(JSON.stringify(list))
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ ok: false, log: String((e && e.message) || e) }))
    }
    return
  }
  res.writeHead(404)
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
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

// macOS 标准"关于"面板：显示应用名、版本与项目 GitHub 地址（website 为
// 可点击的"访问网站"链接，credits 为面板底部展示的文本）。
function configureAboutPanel() {
  try {
    app.setAboutPanelOptions({
      applicationName: APP_TITLE,
      applicationVersion: app.getVersion(),
      credits: '项目地址：https://github.com/qinlinglong/deepseek-harness-desktop',
      website: 'https://github.com/qinlinglong/deepseek-harness-desktop',
    })
  } catch (_) {}
}

function createTray() {
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => restoreWindow() },
    { label: '打开迷你窗口', click: () => toggleMini() },
    {
      label: config.showFloat ? '隐藏悬浮球' : '显示悬浮球',
      click: () => {
        toggleFloat()
        createTray()
      },
    },
    { label: '设置…', click: () => showSettings() },
    { type: 'separator' },
    { label: '在浏览器打开', click: () => openBrowserUrl() },
    {
      label: '复制访问地址',
      enabled: config.mode === 'lan',
      click: () => {
        const ips = lanIPv4s()
        clipboard.writeText(`http://${ips[0] || '127.0.0.1'}:${config.lanPort}/`)
      },
    },
    { type: 'separator' },
    { label: '重启服务', click: () => applyConfig().catch((e) => log('main', '托盘重启 applyConfig: ' + (e && e.message))) },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
  trayMenu = menu

  // 主屏：原生托盘（NSStatusItem，菜单栏条内）。实证：Electron Tray 只会显示在
  // 主显示器菜单栏条内；副屏无法放入可点击的原生条内图标（ObjC 回调限制），
  // 由 syncMenuBarIcons 在副屏放"紧贴菜单栏下沿"的胶囊图标兜底。

  let icon
  try {
    icon = nativeImage.createFromPath(iconPath(config.icon)).resize({ width: 18, height: 18 })
  } catch (_) {
    icon = nativeImage.createEmpty()
  }
  tray = new Tray(icon)
  tray.setToolTip(APP_TITLE)
  // 参考豆包的托盘交互：
  // - macOS：单击=打开主窗口（回主界面），右键=弹出菜单。
  //   不能 setContextMenu——mac 上 setContextMenu 会把左键固定为弹菜单，
  //   无法实现"单击开窗"；改用 click + 右键手动 popUpContextMenu。
  //   若个别 mac 上图标因此不显示，回退方案是 setContextMenu（代价：单击变弹菜单）。
  // - 其他平台：左键 click 打开主窗口 + setContextMenu 提供右键菜单
  if (isMac) {
    tray.on('click', () => restoreWindow())
    tray.on('right-click', () => tray.popUpContextMenu(menu))
  } else {
    tray.setContextMenu(menu)
    tray.on('click', () => restoreWindow())
  }
}

function syncMenuBarIcons() {
  // 副屏原生图标：macOS 公开 API 下，NSStatusItem 只显示在"活跃显示器"
  // 菜单栏（单实例），豆包两屏条内都有是因为用了私有 API（setScreen: +
  // 私有回调），koffi 无法注册 ObjC IMP / CGEventTap 回调。副屏入口
  // 由悬浮球（floatWin）覆盖，可拖到任意屏幕角落。
  for (const [id, win] of menuBarWins) {
    if (!win.isDestroyed()) win.close()
  }
  menuBarWins.clear()
}

function refreshMenuBarIcons() { syncMenuBarIcons() }

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

const ICON_LABELS = { deepseek: 'DeepSeek（默认）', dnee: 'D娘' }

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
    // 仅跳转到设置页并预选"局域网连接"：不在此处改模式/落盘。
    // 之前这里会立即 config.mode='remote' + saveConfigToDisk()，
    // 导致"打开设置→点返回"时 backToMainUI 按已改的 remote 配置去连
    // 未填写的地址（默认 127.0.0.1:3080 常无服务），卡在"正在启动服务"，
    // 且下次启动也沿用 remote。真正生效只由设置页"保存并应用"提交完成。
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
    const prevMode = config.mode
    config.mode = 'lan'
    let started = false
    try {
      started = await applyConfig()
    } catch (e) {
      log('main', `switchMode(lan) applyConfig: ${e && e.message}`)
    }
    if (!started) {
      // 启动失败：回滚模式，避免"卡在局域网模式"且无法退出
      config.mode = prevMode
      saveConfigToDisk()
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
      if (response !== 1) {
        // 用户取消"确定开启"：回滚到原模式，恢复原服务
        config.mode = prevMode
        saveConfigToDisk()
        applyConfig().catch((e) => log('main', `switchMode(lan) rollback applyConfig: ${e && e.message}`))
        return
      }
      if (urls[0]) openExternalSafe(urls[0])
    })
    return
  }
  config.mode = mode
  saveConfigToDisk()
  try {
    await applyConfig()
  } catch (e) {
    log('main', `switchMode(${mode}) applyConfig: ${e && e.message}`)
  }
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
            // 取消置顶：还原 level + 关 visibleOnAllWorkspaces，
            // 并撤销 macOS 原生 setLevel(27)/collectionBehavior，否则原生层级残留导致无法取消置顶
            floatWin.setAlwaysOnTop(false)
            floatWin.setVisibleOnAllWorkspaces(false)
            if (nativeFloatTop && process.platform === 'darwin') nativeFloatTop.revertNativeFloatTop(floatWin)
          }
        }
      },
    },
    { type: 'separator' },
    { label: '打开设置', click: () => showSettings() },
    { type: 'separator' },
    { label: '隐藏悬浮球', click: () => toggleFloat() },
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

// 从设置页「取消/返回」回到主界面（当前模式的 harness / 远程页面），避免停留在启动转圈页
function backToMainUI() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // remote 从未成功连过：不硬连不可达地址（否则一直"正在启动服务"），
  // 回启动页展示真实状态（失败会显示错误与"设置"入口）
  if (config.mode === 'remote' && !remoteConnectedOnce) {
    try { mainWindow.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html')) } catch (_) {}
    return
  }
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
// Electron 的 setAlwaysOnTop + setVisibleOnAllWorkspaces 作为跨平台基线；
// macOS 上由 nativeFloatTop.applyNativeFloatTop() 原生覆盖 level=27 和
// collectionBehavior（豆包同款），覆盖 Electron API 在 macOS Sonoma+ 的不可靠行为。
function reapplyFloatTop() {
  if (!floatWin || floatWin.isDestroyed()) return
  if (floatWin._floatOnTop === false) return
  try {
    floatWin.setAlwaysOnTop(true, FLOAT_LEVEL)
    floatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
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
      if (now - lastFloatRefresh < FLOAT_FORCE_REFRESH_INTERVAL_MS) return
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
    // macOS 上用 NSPanel（非激活面板，豆包/Raycast 同款）。NSPanel + 原生
    // setLevel(27) + FullScreenAuxiliary 才能在全屏 Space / 最大化窗口上置顶；
    // 普通 NSWindow 即使 level 相同也会被系统在全屏 Space 下剔除。
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'floating-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  floatWin.loadFile(path.join(__dirname, 'renderer', 'floating.html'))
  floatWin._floatOnTop = true
  // 关键：悬浮球设为不可聚焦（仿豆包辅助面板）。macOS 全屏 Space 的
  // FullScreenAuxiliary 集合行为对"不抢键盘焦点的辅助窗口"更友好——
  // 抢焦点的普通 window 在进入全屏 Space 时会被系统隐藏，而
  // non-activating/focusable:false 的窗口作为"辅助面板"可进入并显示。
  // 这也是豆包悬浮球点击不抢焦点的原因。
  floatWin.setFocusable(false)
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
    saveTimer = setTimeout(() => saveConfigToDisk(), DEBOUNCE_MS)
    saveTimer.unref && saveTimer.unref()
  })

  // 渲染进程崩溃（OOM/崩溃）时自动重建悬浮球，避免悬浮球静默消失
  floatWin.webContents.on('render-process-gone', (_e, details) => {
    log('main', `float renderer gone: ${details.reason}`)
    if (!floatWin || floatWin.isDestroyed()) return
    const shouldRestore = config.showFloat
    try { floatWin.destroy() } catch (_) {}
    floatWin = null
    if (shouldRestore) setTimeout(() => createFloatWindow(), 300)
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

function sendMiniUrl() {
  if (!miniWin || miniWin.isDestroyed()) return
  const url = currentWebUrl()
  if (url) miniWin.webContents.send('mini:url', url)
}

// 迷你窗置顶（豆包同款 NSPanel + 原生 level=27 + collectionBehavior）。
// miniPinned=true 时置顶并跨 Space，false 时恢复普通窗口。
function reapplyMiniTop() {
  if (!miniWin || miniWin.isDestroyed()) return
  try {
    if (miniPinned) {
      miniWin.setAlwaysOnTop(true, FLOAT_LEVEL)
      if (isMac) {
        miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
        if (nativeFloatTop) nativeFloatTop.applyNativeFloatTop(miniWin)
      }
    } else {
      miniWin.setAlwaysOnTop(false)
      if (isMac) {
        try { miniWin.setVisibleOnAllWorkspaces(false) } catch (_) {}
        if (nativeFloatTop) nativeFloatTop.revertNativeFloatTop(miniWin)
      }
    }
  } catch (_) {}
}

// 迷你窗定位到悬浮球附近（豆包同款）：优先悬浮球上方，空间不足回退下方；
// 水平右对齐悬浮球，超出屏幕则贴边。
function positionMiniNearFloat() {
  if (!miniWin || miniWin.isDestroyed()) return
  if (!floatWin || floatWin.isDestroyed()) return
  try {
    const fb = floatWin.getBounds()
    const [mw, mh] = miniWin.getSize()
    const wa = screen.getDisplayMatching(fb).workArea
    const GAP = 8
    let x = fb.x + fb.width - mw
    let y = fb.y - mh - GAP
    if (y < wa.y) y = fb.y + fb.height + GAP
    if (x < wa.x) x = wa.x
    if (x + mw > wa.x + wa.width) x = wa.x + wa.width - mw
    if (y + mh > wa.y + wa.height) y = wa.y + wa.height - mh
    if (y < wa.y) y = wa.y
    miniWin.setPosition(Math.round(x), Math.round(y))
  } catch (_) {}
}

function toggleMini() {
  if (!miniWin || miniWin.isDestroyed()) {
    createMiniWindow()
  } else if (miniWin.isVisible()) {
    miniWin.hide()
  } else {
    reapplyMiniTop()
    positionMiniNearFloat()
    // showInactive：不激活 app、不切换 Space。若用 focus() 打开，第一次点击
    // 悬浮球时 app 未激活，focus 会触发 macOS 切换到 app 所在桌面 Space（跳转桌面）。
    miniWin.showInactive()
    sendMiniUrl()
  }
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.on('dsh:restart', () => applyConfig().catch((e) => log('main', 'dsh:restart applyConfig: ' + (e && e.message))))
  ipcMain.on('dsh:back', () => backToMainUI())

  ipcMain.on('float:drag-start', () => {
    if (!floatWin || floatWin.isDestroyed()) return
    const pt = screen.getCursorScreenPoint()
    const [wx, wy] = floatWin.getPosition()
    floatGrab = { ox: pt.x - wx, oy: pt.y - wy }
    // 拖动开始即刷新防抖：拖动期间 + 拖动后 600ms 内禁止 forceRefresh
    // 的 hide+show 重绘，否则 pointerup 后悬浮球 blur 触发重绘会让窗口闪一下
    lastFloatRefresh = Date.now()
    // 原生强制手型光标（拖动期间窗口 setPosition 高频移动会重置 CSS 光标）
    if (nativeFloatTop && process.platform === 'darwin') nativeFloatTop.setFloatCursor(true)
  })
  ipcMain.on('float:drag-move', () => {
    if (!floatWin || floatWin.isDestroyed() || !floatGrab) return
    const pt = screen.getCursorScreenPoint()
    floatWin.setPosition(Math.round(pt.x - floatGrab.ox), Math.round(pt.y - floatGrab.oy))
    // 拖动过程中持续刷新防抖，避免 1.5s 轮询的 reapply 与高频 setPosition 叠加造成闪烁
    lastFloatRefresh = Date.now()
    // 每次 move 都续设手型，防止 Chromium 光标更新覆盖
    if (nativeFloatTop && process.platform === 'darwin') nativeFloatTop.setFloatCursor(true)
  })
  ipcMain.on('float:drag-end', () => {
    floatGrab = null
    // 拖动结束刷新防抖：阻断 pointerup 后 blur 触发的 forceRefresh 重绘
    lastFloatRefresh = Date.now()
    // 恢复默认箭头光标，避免影响其他窗口
    if (nativeFloatTop && process.platform === 'darwin') nativeFloatTop.setFloatCursor(false)
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
      reapplyMiniTop()
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

  ipcMain.handle('dsh:get-status', () => lastStatus)

  ipcMain.handle('dsh:get-config', () => ({
    mode: config.mode,
    lanPort: config.lanPort,
    remoteHost: config.remoteHost,
    remotePort: config.remotePort,
    remoteScheme: config.remoteScheme,
    remotePassword: config.remotePassword || '',
    remoteCapable,
    remoteCapableAuthError,
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
    config.remotePassword = String((cfg && cfg.remotePassword) || '')
    if (ICON_FILES[cfg && cfg.icon]) config.icon = cfg.icon
    if (cfg && typeof cfg.showFloat === 'boolean') config.showFloat = cfg.showFloat
    if (mode === 'lan' && !config.passwordHash && !(cfg && cfg.password && String(cfg.password).trim())) {
      return { ok: false, error: '局域网服务端必须设置访问密码' }
    }
    if (cfg && cfg.password && String(cfg.password).trim()) {
      config.passwordHash = hashPassword(String(cfg.password))
      // 改密即吊销所有已签发的局域网登录令牌，旧令牌立即失效
      loginSessions.clear()
      log('main', 'password changed, all LAN login sessions revoked')
    }
    // 从设置页保存局域网服务端：ready 后弹出地址框显示 IP/端口，不直接跳转 dsh 界面
    if (mode === 'lan') pendingLanAddressModal = true
    saveConfigToDisk()
    applyIcon()
    applyFloatState()
    applyConfig().catch((e) => log('main', 'save-config applyConfig: ' + (e && e.message)))
    return { ok: true }
  })

  ipcMain.on('dsh:open-external', (_e, url) => openExternalSafe(url))

  ipcMain.handle('dsh:get-prompts', () => loadPrompts())
  ipcMain.handle('dsh:save-prompts', (_e, arr) => savePrompts(arr))
  ipcMain.on('mini:run-prompt', (_e, text) => runPromptFast(String(text || '')))

  // 插件市场
  ipcMain.handle('dsh:get-market-sources', () => config.marketSources)
  ipcMain.handle('dsh:save-market-sources', (_e, arr) => {
    config.marketSources = market.normalizeMarketSources(arr)
    saveConfigToDisk()
    return config.marketSources
  })
  ipcMain.handle('dsh:market-browse', async (_e, sourceId) => {
    const s = config.marketSources.find((x) => x.id === sourceId)
    if (!s) throw new Error('市场源不存在')
    return market.browseMarket(s)
  })
  ipcMain.handle('dsh:plugin-install', async (_e, pkg) => {
    if (config.mode === 'remote') {
      if (!remoteCapable) {
        return { ok: false, log: '远端不是桌面版服务，无法远程安装。请在该服务端执行 `dsh plugin --profile web add ' + String(pkg) + '`' + (remoteCapableAuthError ? '（远端密码错误）' : '') }
      }
      const r = await remoteRequest('POST', '/desktop/plugin-install', { cookie: cachedRemoteCookie, body: { pkg: String(pkg), action: 'add' } })
      if (!r) return { ok: false, log: '无法连接远端桌面服务' }
      if (r.status === 401) return { ok: false, log: '远端密码错误，请在设置填写正确的远端访问密码' }
      return { ok: !!(r.json && r.json.ok), log: (r.json && r.json.log) || r.text || ('HTTP ' + r.status) }
    }
    const r = await market.runDshPlugin(dshBinPath(), app.getPath('home'), ['add', String(pkg)], pluginEnv(app.getPath('home')))
    return { ok: r.code === 0, log: r.log }
  })
  ipcMain.handle('dsh:plugin-uninstall', async (_e, pkg) => {
    if (config.mode === 'remote') {
      if (!remoteCapable) {
        return { ok: false, log: '远端不是桌面版服务，无法远程卸载。请在该服务端执行 `dsh plugin --profile web remove ' + String(pkg) + '`' + (remoteCapableAuthError ? '（远端密码错误）' : '') }
      }
      const r = await remoteRequest('POST', '/desktop/plugin-install', { cookie: cachedRemoteCookie, body: { pkg: String(pkg), action: 'remove' } })
      if (!r) return { ok: false, log: '无法连接远端桌面服务' }
      if (r.status === 401) return { ok: false, log: '远端密码错误，请在设置填写正确的远端访问密码' }
      return { ok: !!(r.json && r.json.ok), log: (r.json && r.json.log) || r.text || ('HTTP ' + r.status) }
    }
    const r = await market.runDshPlugin(dshBinPath(), app.getPath('home'), ['remove', String(pkg)], pluginEnv(app.getPath('home')))
    return { ok: r.code === 0, log: r.log }
  })
  ipcMain.handle('dsh:plugin-list', async () => {
    if (config.mode === 'remote') {
      if (!remoteCapable) return []
      const r = await remoteRequest('GET', '/desktop/plugin-list', { cookie: cachedRemoteCookie })
      if (!r || r.status === 401) return []
      if (r.json && Array.isArray(r.json)) return r.json
      return []
    }
    return market.listInstalledPlugins(dshBinPath(), app.getPath('home'), pluginEnv(app.getPath('home')))
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
  configureAboutPanel()
  createWindow()
  createTray()
  applyIcon()
  registerIpc()
  syncMenuBarIcons()
  applyFloatState()
  registerScreenMetricsListener()
  registerGlobalShortcuts()
  try {
    await applyConfig()
  } catch (e) {
    log('main', `onReady applyConfig: ${e && e.message}`)
  }
  // 渲染预热（借鉴豆包 warmup_render）：服务就绪后延迟 800ms 预创建迷你聊天窗
  // (show:false)，首次点击悬浮球时直接 show()，消除约 200ms 白屏。窗口轻量、
  // 后台 HTML 已缓存，预热开销极小。
  setTimeout(() => {
    try {
      if (!miniWin && !floatWin && !isQuitting) return
      if (!miniWin || miniWin.isDestroyed()) {
        // 仅预热 HTML，不显示
        const w = new BrowserWindow({
          width: 420, height: 680, minWidth: 320, minHeight: 480,
          frame: false, show: false, alwaysOnTop: false,
          backgroundColor: '#0b0d16', title: APP_TITLE,
          ...(isMac ? { type: 'panel' } : {}),
          webPreferences: {
            preload: path.join(__dirname, 'renderer', 'mini-preload.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true,
          },
        })
        w.loadFile(path.join(__dirname, 'renderer', 'mini.html'))
        // 不挂接到 miniWin 变量，仅缓存预热的渲染进程；createMiniWindow 复用它
        _warmupMiniWin = w
        log('main', 'mini window warmup ready')
      }
    } catch (_) {}
  }, WARMUP_DELAY_MS).unref()
}

let _warmupMiniWin = null

// 迷你窗 webview 注入精简 CSS（只留对话列，隐藏 sidebar/details）。
// 预热/新建路径共用，避免重复代码；dom-ready 时先移除旧样式再注入。
function setupMiniCssInjection(win) {
  if (!win || win.isDestroyed()) return
  win.webContents.on('did-attach-webview', (_e, guest) => {
    setupSelectionAsk(guest)
    let cssKey = null
    guest.on('dom-ready', () => {
      if (cssKey) guest.removeInsertedCSS(cssKey).catch(() => {})
      guest.insertCSS(MINI_CSS).then((k) => { cssKey = k }).catch(() => {})
    })
  })
}

function createMiniWindow(focusAfterShow = false) {
  if (miniWin && !miniWin.isDestroyed()) {
    // 已存在：点击悬浮球打开用 showInactive（不切 Space），快捷键呼出才 focus
    if (focusAfterShow) {
      miniWin.show()
      miniWin.focus()
    } else {
      miniWin.showInactive()
    }
    return
  }
  // 复用预热窗口（如果存在且未销毁），消除首屏白屏
  if (_warmupMiniWin && !_warmupMiniWin.isDestroyed()) {
    miniWin = _warmupMiniWin
    _warmupMiniWin = null
    reapplyMiniTop()
    // 关键修复：预热窗口的 mini.html 早已 did-finish-load，不能再用 once('did-finish-load')
    // 等 finish 再 sendMiniUrl，否则永远不会触发。改为立即 sendMiniUrl，并确保 mini:pin
    // 也已发送（mini.html 加载时已 send pin 一次但 miniPinned 可能在预热后被改）。
    miniWin.webContents.send('mini:pin', miniPinned)
    sendMiniUrl()
    positionMiniNearFloat()
    if (focusAfterShow) {
      miniWin.show()
      miniWin.focus()
    } else {
      miniWin.showInactive()
    }
    // resize 持久化（与下方新建路径一致）
    let saveMiniTimer = null
    const saveMiniBounds = () => {
      if (!miniWin || miniWin.isDestroyed()) return
      clearTimeout(saveMiniTimer)
      saveMiniTimer = setTimeout(() => {
        if (!miniWin || miniWin.isDestroyed()) return
        try {
          const s = miniWin.getSize()
          if (s[0] >= 320 && s[1] >= 480) {
            config.miniBounds = { width: s[0], height: s[1] }
            saveConfigToDisk()
          }
        } catch (_) {}
      }, DEBOUNCE_MS)
      if (saveMiniTimer.unref) saveMiniTimer.unref()
    }
    miniWin.on('resize', saveMiniBounds)
    setupMiniCssInjection(miniWin)
    miniWin.on('closed', () => { miniWin = null })
    return
  }
  // 借鉴豆包 chat_window 持久化：迷你窗尺寸恢复
  const saved = config.miniBounds && Number.isFinite(config.miniBounds.width) && Number.isFinite(config.miniBounds.height)
    ? { width: Math.max(320, config.miniBounds.width), height: Math.max(480, config.miniBounds.height) }
    : { width: 420, height: 680 }
  miniWin = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    minWidth: 320,
    minHeight: 480,
    frame: false,
    show: false,
    alwaysOnTop: miniPinned,
    backgroundColor: '#0b0d16',
    title: APP_TITLE,
    // macOS 用 NSPanel（豆包 chat_window 同款），全屏 Space 下置顶且不抢主应用焦点
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'mini-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })
  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'))
  miniWin.once('ready-to-show', () => {
    reapplyMiniTop()
    positionMiniNearFloat()
    if (focusAfterShow) {
      miniWin.show()
      miniWin.focus()
    } else {
      miniWin.showInactive()
    }
  })
  // 迷你窗尺寸变化时持久化（防抖 600ms）
  let saveMiniTimer = null
  const saveMiniBounds = () => {
    if (!miniWin || miniWin.isDestroyed()) return
    clearTimeout(saveMiniTimer)
    saveMiniTimer = setTimeout(() => {
      if (!miniWin || miniWin.isDestroyed()) return
      try {
        const s = miniWin.getSize()
        if (s[0] >= 320 && s[1] >= 480) {
          config.miniBounds = { width: s[0], height: s[1] }
          saveConfigToDisk()
        }
      } catch (_) {}
    }, DEBOUNCE_MS)
    if (saveMiniTimer.unref) saveMiniTimer.unref()
  }
  miniWin.on('resize', saveMiniBounds)
  setupMiniCssInjection(miniWin)
  miniWin.webContents.once('did-finish-load', () => {
    miniWin.webContents.send('mini:pin', miniPinned)
    sendMiniUrl()
  })
  // 渲染进程崩溃时：若迷你窗正在显示，自动重建；隐藏则重置引用
  miniWin.webContents.on('render-process-gone', (_e, details) => {
    log('main', `mini renderer gone: ${details.reason}`)
    if (!miniWin || miniWin.isDestroyed()) return
    const wasVisible = miniWin.isVisible()
    try { miniWin.destroy() } catch (_) {}
    miniWin = null
    if (wasVisible) setTimeout(() => createMiniWindow(), 300)
  })
  miniWin.on('closed', () => {
    miniWin = null
  })
}

// 全局快捷键（借鉴豆包 shortcut.mouse_launch）：即使应用没聚焦也能呼出窗口。
// Cmd/Ctrl+Shift+D = 打开/聚焦主窗口；Alt+D = 切换迷你聊天窗；Alt+S = 切换悬浮球。
// 桌面端登录系统后注册，退出时 Electron 自动注销，无需显式管理。
let globalShortcutsRegistered = false
function registerGlobalShortcuts() {
  if (globalShortcutsRegistered) return
  const ok1 = globalShortcut.register('CommandOrControl+Shift+D', () => {
    // 主窗口：存在则前置，不存在则创建（不触发服务重启）
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  const ok2 = globalShortcut.register('Alt+D', () => {
    // 迷你聊天窗：开/关切换。快捷键呼出需要获得焦点（可立即输入）
    if (!miniWin || miniWin.isDestroyed()) {
      createMiniWindow(true)
    } else if (miniWin.isVisible()) {
      miniWin.hide()
    } else {
      reapplyMiniTop()
      miniWin.show()
      miniWin.focus()
      sendMiniUrl()
    }
  })
  const ok3 = globalShortcut.register('Alt+S', () => {
    // 悬浮球：显隐切换
    toggleFloat()
  })
  if (ok1) log('main', 'global shortcut Cmd+Shift+D: 唤起主窗 已注册')
  if (ok2) log('main', 'global shortcut Alt+D: 切换迷你聊天 已注册')
  if (ok3) log('main', 'global shortcut Alt+S: 切换悬浮球 已注册')
  globalShortcutsRegistered = ok1 || ok2 || ok3
}

let gracefulQuitStarted = false
app.on('before-quit', (e) => {
  isQuitting = true
  // 立即销毁所有界面窗口：点"退出应用"后用户即刻看到全部界面消失
  // （曾出现主窗口迟迟不关，观感像"没退出"）
  for (const w of [mainWindow, miniWin, floatWin]) {
    if (w && !w.isDestroyed()) w.destroy()
  }
  for (const [id, win] of menuBarWins) {
    if (win && !win.isDestroyed()) win.destroy()
  }
  menuBarWins.clear()
  // 兜底：若 stopServer/stopAuthProxy 异常卡住，4 秒后强制退出
  setTimeout(() => { try { app.exit(0) } catch (_) {} }, 4000)
  // 注销全局快捷键（Electron 会自动做，但显式确保万无一失）
  try { globalShortcut.unregisterAll() } catch (_) {}
  // 二次触发（优雅退出完成后 app.quit()）直接放行
  if (gracefulQuitStarted) return
  e.preventDefault()
  gracefulQuitStarted = true
  ;(async () => {
    try { await stopServer() } catch (_) {} // 等待 dsh 进程完全退出，避免残留写坏会话日志
    try { stopAuthProxy() } catch (_) {}
    app.quit()
  })()
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
    // 显示器布局变化（拔插/改主屏）：重建副屏菜单栏图标，保证位置跟随
    syncMenuBarIcons()
  })
}

app.on('activate', () => restoreWindow())
