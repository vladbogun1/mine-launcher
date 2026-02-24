const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherApi', {
  fetchManifest: (url) => ipcRenderer.invoke('fetch-manifest', url),
  syncFiles: () => ipcRenderer.invoke('sync-files'),
  launchGame: () => ipcRenderer.invoke('launch-game'),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  onProgress: (callback) => ipcRenderer.on('sync-progress', (_event, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('log', (_event, data) => callback(data))
});
