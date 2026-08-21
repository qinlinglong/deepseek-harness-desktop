const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshMini', {
  openMain: () => ipcRenderer.send('mini:open-main'),
  togglePin: () => ipcRenderer.send('mini:toggle-pin'),
  minimize: () => ipcRenderer.send('mini:minimize'),
  getPrompts: () => ipcRenderer.invoke('dsh:get-prompts'),
  onUrl: (cb) => ipcRenderer.on('mini:url', (_e, url) => cb(url)),
  onPin: (cb) => ipcRenderer.on('mini:pin', (_e, pinned) => cb(pinned)),
  onRunPrompt: (cb) => ipcRenderer.on('mini:run-prompt', (_e, text) => cb(text)),
})
