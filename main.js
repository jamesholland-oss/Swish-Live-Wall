const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

// Keep Chromium's on-disk/media caches bounded. This does not cap the video
// decoder itself, but it prevents an always-on wall from growing caches forever.
app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(32 * 1024 * 1024));
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate');

const DEFAULT_STREAMS = [
  { name: 'Swish Breaks FN', url: 'https://www.fanatics.live/shows/2fbba9a5-da47-443e-9944-e7f578aae30b' },
  { name: 'Swish Wax FN', url: 'https://www.fanatics.live/shows/86bfa9ee-a115-4804-b272-e342f8491626' },
  { name: 'Swish Bats', url: 'https://www.fanatics.live/shows/debdca0f-bc98-4810-a2d1-e1e421787c26' },
  { name: 'Swish Breaks WN', url: 'https://www.whatnot.com/live/ca5f2818-97f2-4814-88f8-b05d1a6226ef?referringSource=profile' },
  { name: 'Swish Smash WN', url: 'https://www.whatnot.com/live/620075d2-709d-4eba-a931-2b1208b9567f?referringSource=profile' },
  { name: 'Poke Swish', url: 'https://www.whatnot.com/live/031440c2-d8f3-48e2-b3f6-0d9ab1b55352?referringSource=autocomplete' },
  { name: 'Swish Breaks TT', url: 'https://www.tiktok.com/@swishbreaks/live?enter_from_merge=others_homepage&enter_method=others_photo' },
  { name: 'Swish Rips', url: 'https://www.tiktok.com/@swish.rips/live?enter_from_merge=others_homepage&enter_method=others_photo' },
  { name: 'Stream 9', url: '' },
  { name: 'Stream 10', url: '' }
];

function configPath() {
  return path.join(app.getPath('userData'), 'streams.json');
}

function loadStreams() {
  try {
    const saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (Array.isArray(saved) && saved.length === 10) return saved;
  } catch (_) {}
  return DEFAULT_STREAMS;
}

function saveStreams(streams) {
  fs.writeFileSync(configPath(), JSON.stringify(streams, null, 2));
}

function configureStreamSession() {
  const streamSession = session.fromPartition('persist:swish-live-wall');

  // This app only watches public stream pages. Never grant camera, mic,
  // geolocation, notifications, MIDI, etc. to embedded pages.
  streamSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  streamSession.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1100,
    minHeight: 650,
    backgroundColor: '#07090d',
    title: 'Swish Live Wall',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: true,
      devTools: true
    }
  });

  // Lock down guest webviews before Electron attaches them.
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.spellcheck = false;
    webPreferences.backgroundThrottling = true;
  });

  // Keep pop-up windows from multiplying renderer processes.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.backgroundThrottling = true;
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  configureStreamSession();

  ipcMain.handle('streams:get', () => loadStreams());
  ipcMain.handle('streams:save', (_event, streams) => {
    if (!Array.isArray(streams) || streams.length !== 10) {
      throw new Error('Exactly 10 stream slots are required.');
    }
    saveStreams(streams.map((s, i) => ({
      name: String(s.name || `Stream ${i + 1}`).trim(),
      url: String(s.url || '').trim()
    })));
    return loadStreams();
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
