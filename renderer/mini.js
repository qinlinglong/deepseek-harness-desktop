const view = document.getElementById('view')
const pinBtn = document.getElementById('pin')

function clickNewSession() {
  if (!view || !view.executeJavaScript) return
  // 侧边栏被 MINI_CSS 隐藏，但仍可注入触发其"新建会话"按钮
  view.executeJavaScript(`
    (() => {
      const btn = document.querySelector('[data-slot="sidebar"] button[aria-label="新建会话"]')
      if (btn) { btn.click(); return 'ok' }
      return 'notfound'
    })()
  `).then((r) => {
    if (r === 'notfound') {
      // 兜底：重新加载到初始状态（hero 页面可手动开始新对话）
      try { view.reload() } catch (_) {}
    }
  }).catch(() => {})
}

document.getElementById('newChat').addEventListener('click', clickNewSession)

window.dshMini.onUrl((url) => {
  if (url && view.getAttribute('src') !== url) view.setAttribute('src', url)
})

window.dshMini.onPin((p) => {
  pinBtn.classList.toggle('active', !!p)
  pinBtn.title = p ? '取消置顶' : '置顶'
})

document.getElementById('openMain').addEventListener('click', () => window.dshMini.openMain())
pinBtn.addEventListener('click', () => window.dshMini.togglePin())
document.getElementById('minimize').addEventListener('click', () => window.dshMini.minimize())
