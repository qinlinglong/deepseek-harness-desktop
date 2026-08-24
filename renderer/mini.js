const view = document.getElementById('view')
const pinBtn = document.getElementById('pin')
const promptsBtn = document.getElementById('prompts')
const promptList = document.getElementById('promptList')

function safeJson(s) {
  return JSON.stringify(String(s == null ? '' : s))
}

// 往 dsh 输入框安全填入文本（React 受控组件：原生 setter + input 事件）
function fillComposer(text) {
  view.executeJavaScript(`(() => {
    const ta = document.querySelector('textarea:not([readonly])')
    if (!ta) return 'no'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${safeJson(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`).catch(() => {})
}

function clickNewSession() {
  if (!view || !view.executeJavaScript) return
  // 侧边栏被 MINI_CSS 隐藏，但仍可注入触发其"新建会话"按钮
  view.executeJavaScript(`
    (() => {
      const btn = document.querySelector('button[aria-label="新建会话"]')
      if (btn) { btn.click(); return 'ok' }
      return 'notfound'
    })()
  `).then((r) => {
    if (r === 'notfound') {
      try { view.reload() } catch (_) {}
    }
  }).catch(() => {})
}

// 把 prompt 文本作为新会话填入：先点"新建会话"，再等待输入框出现后填入
function promptToDsh(text, opts = {}) {
  if (!view || !view.executeJavaScript) return
  const run = () => {
    if (opts.newSession !== false) clickNewSession()
    let tries = 0
    const t = setInterval(() => {
      if (++tries > 40) { clearInterval(t); return }
      view.executeJavaScript(`(() => document.querySelector('textarea') != null)()`)
        .then((ok) => { if (ok) { clearInterval(t); fillComposer(text) } })
        .catch(() => { clearInterval(t); fillComposer(text) })
    }, 150)
  }
  const waitView = () => {
    if (view.getAttribute('src')) return Promise.resolve()
    return new Promise((res) => {
      const x = setInterval(() => { if (view.getAttribute('src')) { clearInterval(x); res() } }, 150)
      setTimeout(() => { clearInterval(x); res() }, 8000)
    })
  }
  waitView().then(() => setTimeout(run, 120))
}

// 快捷指令浮层
let promptsCache = []
function renderPromptList() {
  promptList.innerHTML = ''
  if (!promptsCache.length) {
    const empty = document.createElement('div')
    empty.className = 'pli empty'
    empty.textContent = '暂无快捷指令，可在设置中添加'
    promptList.appendChild(empty)
    return
  }
  for (const p of promptsCache) {
    const item = document.createElement('div')
    item.className = 'pli'
    item.textContent = p.name
    item.title = p.content
    item.addEventListener('click', () => {
      promptList.classList.remove('open')
      promptToDsh(p.content, { newSession: true })
    })
    promptList.appendChild(item)
  }
}
promptsBtn.addEventListener('click', async () => {
  try { promptsCache = await window.dshMini.getPrompts() } catch (_) {}
  renderPromptList()
  promptList.classList.toggle('open')
})
document.addEventListener('pointerdown', (e) => {
  if (promptList.classList.contains('open') && !promptList.contains(e.target) && e.target !== promptsBtn) {
    promptList.classList.remove('open')
  }
}, true)
view.addEventListener('focus', () => {
  promptList.classList.remove('open')
})

document.getElementById('newChat').addEventListener('click', clickNewSession)

window.dshMini.onUrl((url) => {
  if (url && view.getAttribute('src') !== url) { view.setAttribute('src', url); promptList.classList.remove('open') }
})

window.dshMini.onPin((p) => {
  pinBtn.classList.toggle('active', !!p)
  pinBtn.title = p ? '取消置顶' : '置顶'
})

window.dshMini.onRunPrompt((text) => promptToDsh(text, { newSession: true }))

document.getElementById('openMain').addEventListener('click', () => window.dshMini.openMain())
pinBtn.addEventListener('click', () => window.dshMini.togglePin())
document.getElementById('minimize').addEventListener('click', () => window.dshMini.minimize())
