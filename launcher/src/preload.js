const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcherApi', {
  listBuilds: () => ipcRenderer.invoke('list-builds'),
  createBuild: (payload) => ipcRenderer.invoke('create-build', payload),
  fetchManifest: (buildId) => ipcRenderer.invoke('fetch-manifest', buildId),
  loadTheme: (buildId) => ipcRenderer.invoke('load-theme', buildId),
  syncFiles: (buildId) => ipcRenderer.invoke('sync-files', buildId),
  launchGame: (buildId) => ipcRenderer.invoke('launch-game', buildId),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  onProgress: (callback) => ipcRenderer.on('sync-progress', (_event, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('log', (_event, data) => callback(data))
});
