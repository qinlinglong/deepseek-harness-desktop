const { contextBridge, ipcRenderer } = require('electron')

// 仅对本地设置/启动页(file://)暴露桥接，避免 remote 模式下第三方网页
// 通过 dshDesktop.saveConfig 等滥用本机能力（改密码/开局域网/退出应用）。
if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('dshDesktop', {
  onStatus: (cb) => ipcRenderer.on('dsh:status', (_e, status) => cb(status)),
  onShowSettings: (cb) => ipcRenderer.on('dsh:show-settings', (_e, mode) => cb(mode)),
  restart: () => ipcRenderer.send('dsh:restart'),
  back: () => ipcRenderer.send('dsh:back'),
  getConfig: () => ipcRenderer.invoke('dsh:get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('dsh:save-config', cfg),
  getIcons: () => ipcRenderer.invoke('dsh:get-icons'),
  version: () => ipcRenderer.invoke('dsh:version'),
  quit: () => ipcRenderer.send('dsh:quit'),
  })
}
