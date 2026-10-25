const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const name of ['snapshot', 'add', 'review', 'action', 'settings', 'chooseDirectory', 'clipboard', 'integration', 'browserSetup', 'registerBrowser','openProgress','closeProgress','resizeProgress']) api[name] = data => ipcRenderer.invoke(`downloader:${name}`, data);
api.subscribe = callback => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on('downloader:change', listener);
  return () => ipcRenderer.removeListener('downloader:change', listener);
};
api.onCommand = callback => {
  const listener = (_event, command) => callback(command);
  ipcRenderer.on('downloader:command', listener);
  return () => ipcRenderer.removeListener('downloader:command', listener);
};
contextBridge.exposeInMainWorld('downloader', Object.freeze(api));
