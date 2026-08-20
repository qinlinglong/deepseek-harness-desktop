// dsh-desktop 冒烟测试（harness rc.8 合并回归）
// 运行：node_modules/.bin/electron scripts/smoke.cjs
// 覆盖：静态语法/依赖版本 → dsh 服务启动/CLI → Web UI DOM → MINI_CSS 注入
'use strict'
const { app, BrowserWindow } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`)
}

// 与 main.js 的 MINI_CSS 保持一致（防止单独改一处造成迷你窗布局回归）
const MINI_CSS = `
[data-slot="sidebar"] { display: none !important; }
[data-slot="details"] { display: none !important; }
[class$="_frame"] { grid-template-columns: 0px 1fr 0px !important; }
`

// ---------- 静态检查 ----------
function staticChecks() {
  for (const f of ['main.js', 'preload.js', 'renderer/mini.js', 'renderer/index.html', 'scripts/native-float.js']) {
    const p = path.join(ROOT, f)
    if (!fs.existsSync(p)) { check(`file exists ${f}`, false); continue }
    if (f.endsWith('.js')) {
      try { execFileSync(process.execPath, ['--check', p], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); check(`syntax ${f}`, true) }
      catch (e) { check(`syntax ${f}`, false, String(e.stderr || e.message)) }
    } else {
      check(`file exists ${f}`, true)
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const dshVer = pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh']
  check('dsh 依赖版本 rc.8', dshVer === '0.1.0-rc.8', dshVer)
  let installedVer = null
  try { installedVer = require(path.join(ROOT, 'node_modules/@deepseek-ai/dsh/package.json')).version } catch (_) {}
  check('node_modules dsh 已装 rc.8', installedVer === '0.1.0-rc.8', installedVer)
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  check('MINI_CSS 含压平 frame 左侧空白列规则', mainSrc.includes('[class$="_frame"]') && /grid-template-columns:\s*0px/.test(mainSrc))
  check('MINI_CSS 使用 data-slot 语义', mainSrc.includes('[data-slot="sidebar"]') && mainSrc.includes('[data-slot="details"]'))
  check('spawn 带 --no-open（启动不自动开网页）', /\x27--no-open\x27/.test(mainSrc))
  try { check('package.json JSON 合法', true); fs.existsSync(path.join(ROOT, 'renderer/index.html')) && check('renderer 文件齐全', true) } catch (e) { check('package.json JSON 合法', false, e.message) }
}

// ---------- 起 dsh 服务（隔离 HOME，随机端口） ----------
function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}
function fetchUrl(url, timeout = 8000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let b = ''
      res.on('data', (d) => (b += d))
      res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }) })
  })
}
async function ping(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchUrl(`http://127.0.0.1:${port}/`)
    if (r.status === 200) return r
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

let dshProc = null
let dshPort = 0
let dshHome = ''
async function startDsh() {
  dshPort = await findFreePort()
  dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-home-'))
  const bin = path.join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const args = Object.keys(process.env).includes('ELECTRON_RUN_AS_NODE') ? [bin] : []
  dshProc = spawn(process.execPath, [...args, '--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', String(dshPort), '--trusted-host', '127.0.0.1', '--no-open'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: dshHome, USERPROFILE: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dshProc.stdout.on('data', () => {})
  dshProc.stderr.on('data', () => {})
  return ping(dshPort)
}
async function stopDsh() {
  if (dshProc && dshProc.exitCode === null) {
    try { process.kill(-dshProc.pid, 'SIGTERM') } catch (_) { try { dshProc.kill('SIGTERM') } catch (_2) {} }
    await new Promise((r) => { dshProc.once('exit', r); setTimeout(r, 5000) })
  }
  try { fs.rmSync(dshHome, { recursive: true, force: true }) } catch (_) {}
}

// ---------- 服务/CLI 检查 ----------
async function serverChecks() {
  const r = await startDsh()
  check('dsh rc.8 web 服务启动 HTTP 200', !!r && r.status === 200)
  if (r) check('首页为 SPA 骨架 (#root)', r.body.includes('id="root"'), `len=${r.body.length}`)
  // CLI 帮助
  const bin = path.join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  try {
    const out = execFileSync(process.execPath, [bin, 'web', '--help'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: dshHome }, encoding: 'utf8', timeout: 30000 })
    check('dsh web --help 正常输出', out.length > 0, String(out).split('\n')[0] || '')
    check('CLI 支持 --port/--trusted-host', /--port/.test(out) && /trusted-host/.test(out))
  } catch (e) {
    check('dsh web --help 正常输出', false, String(e.stderr || e.message))
  }
  return r
}

// ---------- Web UI DOM 渲染检查 ----------
async function domChecks() {
  const win = new BrowserWindow({ show: false, width: 1000, height: 720 })
  try {
    await win.loadURL(`http://127.0.0.1:${dshPort}/`)
    await new Promise((r) => setTimeout(r, 9000))
    const info = await win.webContents.executeJavaScript(`(() => {
      const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : null }
      return {
        sidebarBefore: disp('[data-slot="sidebar"]'),
        detailsBefore: disp('[data-slot="details"]'),
        hasNewSession: !!document.querySelector('button[aria-label="新建会话"]'),
        hasConversation: !!document.querySelector('[data-slot="conversation"]'),
        hasComposer: !!document.querySelector('[data-slot="conversation.composer"], textarea'),
      }
    })()`)
    check('DOM: 侧栏/详情 data-slot 存在且未隐藏', !!info.sidebarBefore && !!info.detailsBefore && info.sidebarBefore !== 'none' && info.detailsBefore !== 'none', JSON.stringify(info))
    check('DOM: 新建会话按钮存在', !!info.hasNewSession)
    check('DOM: 对话主区/输入区存在', !!info.hasConversation && !!info.hasComposer)
    await win.webContents.insertCSS(MINI_CSS)
    await new Promise((r) => setTimeout(r, 500))
    const after = await win.webContents.executeJavaScript(`(() => ({
      sidebarAfter: (() => { const el = document.querySelector('[data-slot="sidebar"]'); return el ? getComputedStyle(el).display : null })(),
      detailsAfter: (() => { const el = document.querySelector('[data-slot="details"]'); return el ? getComputedStyle(el).display : null })(),
    }))()`)
    check('MINI_CSS 注入后侧栏隐藏', after.sidebarAfter === 'none', after.sidebarAfter)
    check('MINI_CSS 注入后详情隐藏', after.detailsAfter === 'none', after.detailsAfter)
    const frameCols = await win.webContents.executeJavaScript(`(() => {
      const f = document.querySelector('[class$="_frame"]')
      if (!f) return null
      return getComputedStyle(f).gridTemplateColumns
    })()`)
    check('MINI_CSS 压平 frame 左/右空白列', !!frameCols && /^0px \S+ 0px$/.test(frameCols), 'cols=' + frameCols)
  } catch (e) {
    check('DOM 渲染检查', false, e.message)
  }
  try { win.destroy() } catch (_) {}
}

app.whenReady().then(async () => {
  const t0 = Date.now()
  staticChecks()
  const html = await serverChecks()
  if (html) await domChecks()
  else check('跳过 DOM 渲染（服务未就绪）', false)
  await stopDsh()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 冒烟测试完成：${results.length - failed.length}/${results.length} 通过，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s ===`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ' → ' + f.detail : ''}`)
  }
  app.exit(failed.length ? 1 : 0)
})
