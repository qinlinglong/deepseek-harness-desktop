const { contextBridge, ipcRenderer } = require('electron')

// 副屏"菜单栏图标"桥接：仅由 main 进程创建的副屏小图标窗口使用。
contextBridge.exposeInMainWorld('menuBar', {
  click: () => ipcRenderer.send('mb:click'),
  openMenu: (pos) => ipcRenderer.send('mb:menu', pos),
  onIcon: (cb) => ipcRenderer.on('mb:icon', (_e, dataUrl) => cb(dataUrl)),
})