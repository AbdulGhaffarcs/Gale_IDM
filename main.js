'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification, dialog, clipboard, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const os = require('os');
const { DownloadManager, isStreamingUrl } = require('./src/downloadManager');
const { Store } = require('./src/store');
const { startBrowserReceiver } = require('./src/browserReceiver');
const { checkYtDlpAvailable, getVideoInfo } = require('./src/ytDlp');
const { ensureBrowserToken, regenerateBrowserToken } = require('./src/browserToken');

const USER_DATA = app.getPath('userData');
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'Gale');

let mainWindow = null;
let tray = null;
let dm = null;
let store = null;
let browserReceiver = null;
let lastClipboardText = '';
let updatePromptOpen = false;
let updateStatus = { state: 'idle', message: 'Updates are checked automatically.' };

const DOWNLOADABLE_RE = /^https?:\/\/\S+\.(zip|rar|7z|tar|gz|bz2|xz|tgz|exe|msi|deb|rpm|appimage|dmg|pkg|apk|iso|mp4|mkv|mov|avi|webm|mp3|flac|wav|pdf|docx?|xlsx?|pptx?|epub)(\?\S*)?$/i;
const STREAMING_RE = /^https?:\/\/(?:www\.)?(youtube\.com\/|youtu\.be\/|vimeo\.com\/|dailymotion\.com\/|twitch\.tv\/|facebook\.com\/.*\/videos|instagram\.com\/|tiktok\.com\/|twitter\.com\/|x\.com\/|reddit\.com\/|soundcloud\.com\/|bilibili\.com\/)/i;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: '#14171c',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img.resize({ width: 22, height: 22 }));
  tray.setToolTip('Gale Download Manager');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Gale', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()));
}

function showUpdateNotification(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

function setUpdateStatus(state, message, version = null) {
  updateStatus = { state, message, version };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-update:status', updateStatus);
  }
}

async function promptToInstallUpdate() {
  if (updatePromptOpen) return;
  updatePromptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Gale update ready',
      message: 'A Gale update has been downloaded.',
      detail: 'Restart Gale to install the update now, or install it when you are ready.',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      app.isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  } finally {
    updatePromptOpen = false;
  }
}

function startAutoUpdater() {
  // Development runs have no published release metadata and must not check GitHub.
  if (!app.isPackaged) {
    setUpdateStatus('unavailable', 'Updates are available in installed Gale releases.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => setUpdateStatus('checking', 'Checking for updates…'));
  autoUpdater.on('update-available', (info) => {
    setUpdateStatus('downloading', `Version ${info.version} is downloading…`, info.version);
    showUpdateNotification('Gale update available', `Version ${info.version} is downloading in the background.`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-update:toast', { type: 'available', version: info.version });
    }
  });
  autoUpdater.on('update-not-available', () => {
    setUpdateStatus('current', `Gale ${app.getVersion()} is up to date.`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateStatus('ready', `Version ${info.version} is ready to install.`, info.version);
    showUpdateNotification(
      'Gale update ready',
      `Version ${info.version} is ready to install. Click to restart Gale and install it.`,
      promptToInstallUpdate
    );
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-update:toast', { type: 'ready', version: info.version });
    }
    promptToInstallUpdate();
  });
  autoUpdater.on('error', (err) => {
    setUpdateStatus('error', 'Could not check for updates. Please try again later.');
    console.warn('Update check failed:', err.message);
  });

  // Let the main window and tray initialise before making a network request.
  setTimeout(() => autoUpdater.checkForUpdates().catch((err) => {
    console.warn('Update check failed:', err.message);
  }), 15000);
}

function startClipboardWatcher() {
  setInterval(() => {
    if (!dm.settings.clipboardMonitor) return;
    let text;
    try { text = clipboard.readText(); } catch (_) { return; }
    if (!text || text === lastClipboardText) return;
    lastClipboardText = text;
    const trimmed = text.trim();
    if (DOWNLOADABLE_RE.test(trimmed) || STREAMING_RE.test(trimmed)) {
      mainWindow.webContents.send('clipboard:detected', trimmed);
    }
  }, 1500);
}

function wireIpc() {
  ipcMain.handle('downloads:list', () => dm.list());

  ipcMain.handle('downloads:add', async (evt, url, opts) => {
    if (!/^https?:\/\//i.test(url || '')) throw new Error('Please enter a valid http(s) URL');
    return dm.addDownload(url.trim(), opts || {});
  });

  ipcMain.handle('downloads:pause', (evt, id) => dm.pause(id));
  ipcMain.handle('downloads:resume', (evt, id) => dm.resume(id));
  ipcMain.handle('downloads:remove', (evt, id, deleteFile) => dm.remove(id, deleteFile));
  ipcMain.handle('downloads:clearCompleted', () => dm.clearCompleted());
  ipcMain.handle('downloads:openFile', (evt, id) => {
    const d = dm.list().find((x) => x.id === id);
    if (d && d.status === 'completed') shell.openPath(path.join(d.dir, d.filename));
  });
  ipcMain.handle('downloads:showInFolder', (evt, id) => {
    const d = dm.list().find((x) => x.id === id);
    if (d) shell.showItemInFolder(path.join(d.dir, d.filename));
  });

  ipcMain.handle('settings:get', () => dm.settings);
  ipcMain.handle('settings:save', (evt, patch) => { dm.saveSettings(patch); return dm.settings; });
  ipcMain.handle('updates:getStatus', () => ({ ...updateStatus, currentVersion: app.getVersion() }));
  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) {
      return { ...updateStatus, currentVersion: app.getVersion() };
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      setUpdateStatus('error', 'Could not check for updates. Please try again later.');
    }
    return { ...updateStatus, currentVersion: app.getVersion() };
  });

  ipcMain.handle('dialog:chooseDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('clipboard:read', () => {
    try { return clipboard.readText(); } catch (_) { return ''; }
  });
  ipcMain.handle('browserIntegration:openExtensionFolder', () => {
    const extensionDir = app.isPackaged
      ? path.join(process.resourcesPath, 'browser-extension')
      : path.join(__dirname, 'browser-extension');
    return shell.openPath(extensionDir);
  });
  ipcMain.handle('browserIntegration:getToken', () => ensureBrowserToken(store));
  ipcMain.handle('browserIntegration:regenerateToken', () => regenerateBrowserToken(store));

  ipcMain.handle('ytdlp:checkAvailable', () => checkYtDlpAvailable());
  ipcMain.handle('ytdlp:getInfo', async (evt, url) => {
    try {
      return await getVideoInfo(url, { cookiesBrowser: dm.settings.ytdlpCookiesBrowser });
    } catch (err) {
      throw new Error(err.message);
    }
  });
  ipcMain.handle('ytdlp:isStreamingUrl', (evt, url) => isStreamingUrl(url));
}

app.whenReady().then(() => {
  store = new Store(path.join(USER_DATA, 'gale-store.json'), {});
  ensureBrowserToken(store); // generate the pairing code on first run, before the extension can ask for it
  dm = new DownloadManager({ store, defaultDir: DEFAULT_DOWNLOAD_DIR });
  browserReceiver = startBrowserReceiver(
    (url, opts) => dm.addDownload(url, opts),
    () => store.get('browserToken', null)
  );
  dm.on('update', (id) => mainWindow && mainWindow.webContents.send('downloads:update', id));
  dm.on('bulk-update', () => mainWindow && mainWindow.webContents.send('downloads:bulk-update'));
  dm.on('tick', (list) => mainWindow && mainWindow.webContents.send('downloads:tick', list));

  wireIpc();
  createWindow();
  createTray();
  startClipboardWatcher();
  startAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (browserReceiver) browserReceiver.close();
});
app.on('window-all-closed', () => {
  // Keep running in the tray on Linux, like IDM does.
});
