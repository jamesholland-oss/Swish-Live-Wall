const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swish', {
  getStreams: () => ipcRenderer.invoke('streams:get'),
  saveStreams: (streams) => ipcRenderer.invoke('streams:save', streams),
  getAppConfig: () => ipcRenderer.invoke('app:get-config'),
  saveAppConfig: (patch) => ipcRenderer.invoke('app:save-config', patch),
  restartApp: () => ipcRenderer.invoke('app:restart')
});
