'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gale', {
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  addDownload: (url, opts) => ipcRenderer.invoke('downloads:add', url, opts),
  pause: (id) => ipcRenderer.invoke('downloads:pause', id),
  resume: (id) => ipcRenderer.invoke('downloads:resume', id),
  remove: (id, deleteFile) => ipcRenderer.invoke('downloads:remove', id, deleteFile),
  clearCompleted: () => ipcRenderer.invoke('downloads:clearCompleted'),
  openFile: (id) => ipcRenderer.invoke('downloads:openFile', id),
  showInFolder: (id) => ipcRenderer.invoke('downloads:showInFolder', id),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  getUpdateStatus: () => ipcRenderer.invoke('updates:getStatus'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  openBrowserExtensionFolder: () => ipcRenderer.invoke('browserIntegration:openExtensionFolder'),
  getBrowserToken: () => ipcRenderer.invoke('browserIntegration:getToken'),
  regenerateBrowserToken: () => ipcRenderer.invoke('browserIntegration:regenerateToken'),

  checkYtDlp: () => ipcRenderer.invoke('ytdlp:checkAvailable'),
  getVideoInfo: (url) => ipcRenderer.invoke('ytdlp:getInfo', url),
  isStreamingUrl: (url) => ipcRenderer.invoke('ytdlp:isStreamingUrl', url),

  onUpdate: (cb) => ipcRenderer.on('downloads:update', (_e, id) => cb(id)),
  onBulkUpdate: (cb) => ipcRenderer.on('downloads:bulk-update', () => cb()),
  onTick: (cb) => ipcRenderer.on('downloads:tick', (_e, list) => cb(list)),
  onClipboardDetected: (cb) => ipcRenderer.on('clipboard:detected', (_e, url) => cb(url)),
  onAppUpdateStatus: (cb) => ipcRenderer.on('app-update:status', (_e, status) => cb(status)),
  onAppUpdateToast: (cb) => ipcRenderer.on('app-update:toast', (_e, data) => cb(data)),
});
