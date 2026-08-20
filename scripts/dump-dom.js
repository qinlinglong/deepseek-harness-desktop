// 校验/调试：在 rc.8+ web UI 上验证 MINI_CSS（隐藏 sidebar/details）是否生效。
// 用法：先启动 dsh web：node --expose-internals node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port 51233
//      <local electron bin> scripts/dump-dom.js
const { app, BrowserWindow } = require('electron')
const MINI_CSS = `
[data-slot="sidebar"] { display: none !important; }
[data-slot="details"] { display: none !important; }
[class$="_frame"] { grid-template-columns: 0px 1fr 0px !important; }
`
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 420, height: 680 })
  await win.loadURL('http://127.0.0.1:51233/')
  await new Promise((r) => setTimeout(r, 6000))
  const measure = () => win.webContents.executeJavaScript(`(() => {
    const disp = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : null }
    return {
      sidebarDisplay: disp('[data-slot="sidebar"]'),
      detailsDisplay: disp('[data-slot="details"]'),
    }
  })()`)
  const before = await measure()
  await win.webContents.insertCSS(MINI_CSS)
  await new Promise((r) => setTimeout(r, 500))
  const after = await measure()
  console.log('BEFORE:', JSON.stringify(before), '-> EXPECT sidebar/details = contents/flex')
  console.log('AFTER :', JSON.stringify(after), '-> EXPECT sidebar/details = none')
  app.quit()
})
