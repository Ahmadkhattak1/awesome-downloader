const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('aboutApi', Object.freeze({
  info: () => ipcRenderer.invoke('about:info'),
  copy: text => ipcRenderer.invoke('about:copy', text),
  open: url => ipcRenderer.invoke('about:open', url)
}));
