const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { startAgent } = require('./agent/agent');

// Keep existing Swish Live Wall settings/cookies when an installed V1 app is upgraded
// to the Swish Control product name. Fresh installs use the normal Swish Control path.
const legacyUserData = path.join(app.getPath('appData'), 'Swish Live Wall');
if (fs.existsSync(legacyUserData)) app.setPath('userData', legacyUserData);

app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(32 * 1024 * 1024));
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,Translate');

const DEFAULT_STREAMS = [
  { id: 'stream-1', name: 'Swish Breaks FN', url: 'https://www.fanatics.live/shows/2fbba9a5-da47-443e-9944-e7f578aae30b', platform: 'Fanatics', roomId: '' },
  { id: 'stream-2', name: 'Swish Wax FN', url: 'https://www.fanatics.live/shows/86bfa9ee-a115-4804-b272-e342f8491626', platform: 'Fanatics', roomId: '' },
  { id: 'stream-3', name: 'Swish Bats', url: 'https://www.fanatics.live/shows/debdca0f-bc98-4810-a2d1-e1e421787c26', platform: 'Fanatics', roomId: '' },
  { id: 'stream-4', name: 'Swish Breaks WN', url: 'https://www.whatnot.com/live/ca5f2818-97f2-4814-88f8-b05d1a6226ef?referringSource=profile', platform: 'Whatnot', roomId: '' },
  { id: 'stream-5', name: 'Swish Smash WN', url: 'https://www.whatnot.com/live/620075d2-709d-4eba-a931-2b1208b9567f?referringSource=profile', platform: 'Whatnot', roomId: '' },
  { id: 'stream-6', name: 'Poke Swish', url: 'https://www.whatnot.com/live/031440c2-d8f3-48e2-b3f6-0d9ab1b55352?referringSource=autocomplete', platform: 'Whatnot', roomId: '' },
  { id: 'stream-7', name: 'Swish Breaks TT', url: 'https://www.tiktok.com/@swishbreaks/live?enter_from_merge=others_homepage&enter_method=others_photo', platform: 'TikTok', roomId: '' },
  { id: 'stream-8', name: 'Swish Rips', url: 'https://www.tiktok.com/@swish.rips/live?enter_from_merge=others_homepage&enter_method=others_photo', platform: 'TikTok', roomId: '' },
  { id: 'stream-9', name: 'Stream 9', url: '', platform: 'Other', roomId: '' },
  { id: 'stream-10', name: 'Stream 10', url: '', platform: 'Other', roomId: '' }
];

const DEFAULT_APP_CONFIG = {
  role: '',
  serverUrl: '',
  roomName: '',
  agentEnrollmentKey: '',
  obsWebSocketHost: '127.0.0.1',
  obsWebSocketPort: 4455,
  obsWebSocketPassword: ''
};

let mainWindow = null;
let stopAgent = null;

function jsonPath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function loadAppConfig() {
  return { ...DEFAULT_APP_CONFIG, ...readJson(jsonPath('app-config.json'), {}) };
}

function saveAppConfig(patch) {
  const current = loadAppConfig();
  const next = {
    ...current,
    ...patch,
    serverUrl: normalizeServerUrl(patch.serverUrl ?? current.serverUrl),
    obsWebSocketPort: Number(patch.obsWebSocketPort ?? current.obsWebSocketPort) || 4455
  };
  writeJson(jsonPath('app-config.json'), next);
  return next;
}

function inferPlatform(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('fanatics.live')) return 'Fanatics';
  if (value.includes('whatnot.com')) return 'Whatnot';
  if (value.includes('tiktok.com')) return 'TikTok';
  return 'Other';
}

function normalizeStream(stream, index) {
  const platform = ['Fanatics', 'Whatnot', 'TikTok', 'Other'].includes(stream.platform)
    ? stream.platform
    : inferPlatform(stream.url);
  return {
    id: String(stream.id || `stream-${Date.now()}-${index}`).trim(),
    name: String(stream.name || `Stream ${index + 1}`).trim(),
    url: String(stream.url || '').trim(),
    platform,
    roomId: String(stream.roomId || '').trim()
  };
}

function loadStreams() {
  const saved = readJson(jsonPath('streams.json'), null);
  if (Array.isArray(saved) && saved.length >= 1 && saved.length <= 150) return saved.map(normalizeStream);
  return DEFAULT_STREAMS.map(normalizeStream);
}

function saveStreams(streams) {
  if (!Array.isArray(streams) || streams.length < 1 || streams.length > 150) {
    throw new Error('Stream list must contain between 1 and 150 entries.');
  }
  const normalized = streams.map(normalizeStream);
  writeJson(jsonPath('streams.json'), normalized);
  return normalized;
}

function configureStreamSession() {
  const streamSession = session.fromPartition('persist:swish-live-wall');
  streamSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  streamSession.setPermissionCheckHandler(() => false);
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1100,
    minHeight: 650,
    backgroundColor: '#07090d',
    title: 'Swish Control',
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

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.spellcheck = false;
    webPreferences.backgroundThrottling = true;
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadFile('index.html');
  return mainWindow;
}

function configureLoginItem(role) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: role === 'agent', openAsHidden: role === 'agent' });
  } catch (err) {
    console.error('Unable to update login item:', err.message);
  }
}

async function startAgentMode(config) {
  if (stopAgent) return;
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  stopAgent = startAgent({
    serverUrl: config.serverUrl,
    roomName: config.roomName,
    enrollmentKey: config.agentEnrollmentKey,
    obsWebSocketHost: config.obsWebSocketHost,
    obsWebSocketPort: config.obsWebSocketPort,
    obsWebSocketPassword: config.obsWebSocketPassword,
    stateDir: path.join(app.getPath('userData'), 'agent'),
    heartbeatMs: 10000,
    onEnrolled: () => {
      const latest = loadAppConfig();
      if (latest.agentEnrollmentKey) saveAppConfig({ agentEnrollmentKey: '' });
    }
  });
}

function registerIpc() {
  ipcMain.handle('streams:get', () => loadStreams());
  ipcMain.handle('streams:save', (_event, streams) => saveStreams(streams));
  ipcMain.handle('app:get-config', () => loadAppConfig());
  ipcMain.handle('app:save-config', (_event, patch) => {
    const allowed = {
      role: ['wall', 'control', 'agent'].includes(patch?.role) ? patch.role : undefined,
      serverUrl: patch?.serverUrl,
      roomName: patch?.roomName,
      agentEnrollmentKey: patch?.agentEnrollmentKey,
      obsWebSocketHost: patch?.obsWebSocketHost,
      obsWebSocketPort: patch?.obsWebSocketPort,
      obsWebSocketPassword: patch?.obsWebSocketPassword
    };
    Object.keys(allowed).forEach((key) => allowed[key] === undefined && delete allowed[key]);
    const config = saveAppConfig(allowed);
    configureLoginItem(config.role);
    return config;
  });
  ipcMain.handle('app:restart', () => {
    app.relaunch();
    app.exit(0);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const config = loadAppConfig();
    if (config.role === 'agent') return;
    createWindow();
  });

  app.whenReady().then(async () => {
    configureStreamSession();
    registerIpc();
    app.on('web-contents-created', (_event, contents) => {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.backgroundThrottling = true;
    });

    let config = loadAppConfig();
    if (process.argv.includes('--reset-role')) config = saveAppConfig({ role: '' });
    configureLoginItem(config.role);

    if (config.role === 'agent') await startAgentMode(config);
    else createWindow();

    app.on('activate', () => {
      const latest = loadAppConfig();
      if (latest.role !== 'agent' && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  if (stopAgent) stopAgent();
});

app.on('window-all-closed', () => {
  const config = loadAppConfig();
  if (config.role === 'agent') return;
  if (process.platform !== 'darwin') app.quit();
});
