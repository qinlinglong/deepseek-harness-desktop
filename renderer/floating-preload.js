const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshFloat', {
  dragStart: () => ipcRenderer.send('float:drag-start'),
  dragMove: () => ipcRenderer.send('float:drag-move'),
  dragEnd: () => ipcRenderer.send('float:drag-end'),
  toggleMini: () => ipcRenderer.send('float:toggle-mini'),
  showMenu: () => ipcRenderer.send('float:menu'),
  quit: () => ipcRenderer.send('float:quit'),
  onIcon: (cb) => ipcRenderer.on('float:icon', (_e, url) => cb(url)),
})
