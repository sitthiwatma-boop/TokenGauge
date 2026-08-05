'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  setProvider: (id, patch) => ipcRenderer.invoke('set-provider', { id, patch }),
  refresh: () => ipcRenderer.invoke('refresh'),
  calibrate: (id, payload) => ipcRenderer.invoke('calibrate', { id, ...payload }),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  exportCsv: () => ipcRenderer.invoke('export-csv'),
  window: (action) => ipcRenderer.send('window', action),
  setMini: (on) => ipcRenderer.send('set-mini', !!on),
  sendTrayIcon: (dataUrl) => ipcRenderer.send('tray-icon', dataUrl),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, d) => cb(d)),
  onMiniMode: (cb) => ipcRenderer.on('mini-mode', (_e, v) => cb(v))
});
