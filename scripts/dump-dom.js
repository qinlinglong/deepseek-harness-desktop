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
  const before = await win.webContents.executeJavaScript(`(() => {
    const f = document.querySelector('[class$="_frame"]')
    const s = document.querySelector('[class$="_sidebarCol"]')
    const c = document.querySelector('[class$="_centerCol"]')
    return {
      frameW: f ? f.getBoundingClientRect().width : null,
      sidebarW: s ? s.getBoundingClientRect().width : null,
      centerW: c ? c.getBoundingClientRect().width : null,
      grid: f ? getComputedStyle(f).gridTemplateColumns : null,
    }
  })()`)
  await win.webContents.insertCSS(MINI_CSS)
  await new Promise((r) => setTimeout(r, 500))
  const after = await win.webContents.executeJavaScript(`(() => {
    const f = document.querySelector('[class$="_frame"]')
    const c = document.querySelector('[class$="_centerCol"]')
    const s = document.querySelector('[class$="_sidebarCol"]')
    return {
      frameW: f ? f.getBoundingClientRect().width : null,
      centerW: c ? c.getBoundingClientRect().width : null,
      sidebarVisible: s ? getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().width > 1 : null,
      grid: f ? getComputedStyle(f).gridTemplateColumns : null,
    }
  })()`)
  console.log('BEFORE:', JSON.stringify(before))
  console.log('AFTER :', JSON.stringify(after))
  app.quit()
})
