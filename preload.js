const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swish', {
  getStreams: () => ipcRenderer.invoke('streams:get'),
  saveStreams: (streams) => ipcRenderer.invoke('streams:save', streams)
});
