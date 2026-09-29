const { app, BrowserWindow, ipcMain, session, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
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

const SWISH_POKE_URL = 'https://www.tiktok.com/@swishpoke/live?enter_from_merge=others_homepage&enter_method=others_photo';
const SWISH_HITS_URL = 'https://www.whatnot.com/live/84f6aeba-efa9-4a2f-8c39-793c45d19ac6?referringSource=profile';

const DEFAULT_STREAMS = [
  { id: 'stream-1', name: 'Swish Breaks FN', url: 'https://www.fanatics.live/shows/2fbba9a5-da47-443e-9944-e7f578aae30b', platform: 'Fanatics', roomId: '' },
  { id: 'stream-2', name: 'Swish Wax FN', url: 'https://www.fanatics.live/shows/86bfa9ee-a115-4804-b272-e342f8491626', platform: 'Fanatics', roomId: '' },
  { id: 'stream-3', name: 'Swish Bats', url: 'https://www.fanatics.live/shows/debdca0f-bc98-4810-a2d1-e1e421787c26', platform: 'Fanatics', roomId: '' },
  { id: 'stream-4', name: 'Swish Breaks WN', url: 'https://www.whatnot.com/live/ca5f2818-97f2-4814-88f8-b05d1a6226ef?referringSource=profile', platform: 'Whatnot', roomId: '' },
  { id: 'stream-5', name: 'Swish Smash WN', url: 'https://www.whatnot.com/live/620075d2-709d-4eba-a931-2b1208b9567f?referringSource=profile', platform: 'Whatnot', roomId: '' },
  { id: 'stream-6', name: 'Poke Swish', url: 'https://www.whatnot.com/live/031440c2-d8f3-48e2-b3f6-0d9ab1b55352?referringSource=autocomplete', platform: 'Whatnot', roomId: '' },
  { id: 'stream-7', name: 'Swish Breaks TT', url: 'https://www.tiktok.com/@swishbreaks/live?enter_from_merge=others_homepage&enter_method=others_photo', platform: 'TikTok', roomId: '' },
  { id: 'stream-8', name: 'Swish Rips', url: 'https://www.tiktok.com/@swish.rips/live?enter_from_merge=others_homepage&enter_method=others_photo', platform: 'TikTok', roomId: '' },
  { id: 'stream-9', name: 'Swish Poke', url: SWISH_POKE_URL, platform: 'TikTok', roomId: '' },
  { id: 'stream-10', name: 'Swish Hits WN', url: SWISH_HITS_URL, platform: 'Whatnot', roomId: '' }
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
  const streamsFile = jsonPath('streams.json');
  const saved = readJson(streamsFile, null);
  if (Array.isArray(saved) && saved.length >= 1 && saved.length <= 150) {
    let normalized = saved.map(normalizeStream);
    let changed = false;

    const streamNine = normalized.find((stream) => stream.id === 'stream-9');
    if (streamNine) {
      const needsSwishPoke = streamNine.name !== 'Swish Poke' || streamNine.url !== SWISH_POKE_URL || streamNine.platform !== 'TikTok';
      if (needsSwishPoke) {
        streamNine.name = 'Swish Poke';
        streamNine.url = SWISH_POKE_URL;
        streamNine.platform = 'TikTok';
        changed = true;
      }
    }

    // Swish Hits is the canonical 10th wall slot. Earlier beta builds only
    // replaced Stream 10 when it was blank, which could append Swish Hits as
    // an 11th row on upgraded installs. Normalize that here and preserve any
    // room link the appended Swish Hits row may already have.
    let streamTen = normalized.find((stream) => stream.id === 'stream-10') || normalized[9];

    if (!streamTen && normalized.length < 150) {
      streamTen = normalizeStream({
        id: 'stream-10',
        name: 'Swish Hits WN',
        url: SWISH_HITS_URL,
        platform: 'Whatnot',
        roomId: ''
      }, 9);
      normalized.push(streamTen);
      changed = true;
    }

    const duplicateHits = normalized.filter((stream) =>
      stream !== streamTen &&
      (stream.url === SWISH_HITS_URL || /swish hits/i.test(stream.name))
    );

    if (streamTen) {
      const linkedDuplicate = duplicateHits.find((stream) => stream.roomId);
      const desiredRoomId = streamTen.roomId || linkedDuplicate?.roomId || '';

      if (
        streamTen.id !== 'stream-10' ||
        streamTen.name !== 'Swish Hits WN' ||
        streamTen.url !== SWISH_HITS_URL ||
        streamTen.platform !== 'Whatnot' ||
        streamTen.roomId !== desiredRoomId
      ) {
        streamTen.id = 'stream-10';
        streamTen.name = 'Swish Hits WN';
        streamTen.url = SWISH_HITS_URL;
        streamTen.platform = 'Whatnot';
        streamTen.roomId = desiredRoomId;
        changed = true;
      }
    }

    if (duplicateHits.length) {
      const duplicateIds = new Set(duplicateHits.map((stream) => stream.id));
      normalized = normalized.filter((stream) => !duplicateIds.has(stream.id));
      changed = true;
    }

    if (changed) writeJson(streamsFile, normalized);
    return normalized;
  }
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

async function controlFetch(request = {}) {
  const configuredUrl = normalizeServerUrl(loadAppConfig().serverUrl);
  if (!configuredUrl) throw new Error('Server URL is not configured.');

  let target;
  let allowed;
  try {
    target = new URL(String(request.url || ''));
    allowed = new URL(configuredUrl);
  } catch (_) {
    throw new Error('Invalid control server URL.');
  }

  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== allowed.origin) {
    throw new Error('Control request was blocked.');
  }

  const method = String(request.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'DELETE', 'OPTIONS'].includes(method)) {
    throw new Error('Unsupported control request method.');
  }

  const headers = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    headers[String(key)] = String(value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await net.fetch(target.href, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : request.body,
      signal: controller.signal
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Control server request timed out.');
    throw new Error(err?.message || 'Control server request failed.');
  } finally {
    clearTimeout(timer);
  }
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const isAgent = loadAppConfig().role === 'agent';
  if (isAgent && process.platform === 'darwin' && app.dock) app.dock.show();

  mainWindow = new BrowserWindow({
    width: isAgent ? 560 : 1920,
    height: isAgent ? 390 : 1080,
    minWidth: isAgent ? 460 : 1100,
    minHeight: isAgent ? 320 : 650,
    resizable: true,
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
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (loadAppConfig().role === 'agent' && process.platform === 'darwin' && app.dock) app.dock.hide();
  });
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

function execFileText(command, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), error });
    });
  });
}

function normalizeOcrCandidate(value) {
  return String(value || '')
    .replace(/[|]/g, 'I')
    .replace(/[^A-Za-z.'’\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function likelyPlayerNameFromOcr(lines) {
  const blocked = new Set([
    'TOPPS', 'PANINI', 'PRIZM', 'CHROME', 'SELECT', 'OPTIC', 'ROOKIE', 'ROOKIE CARD',
    'BOWMAN', 'DONRUSS', 'FINEST', 'MOSAIC', 'NATIONAL TREASURES', 'IMMACULATE',
    'FLAWLESS', 'SPECTRA', 'REVOLUTION', 'ORIGINS', 'CERTIFIED', 'ABSOLUTE',
    'CONTENDERS', 'HOOPS', 'SCORE', 'UPPER DECK', 'FLEER', 'SKYBOX', 'LEAF',
    'AUTOGRAPH', 'SIGNATURE', 'REFRACTOR', 'INSERT', 'PARALLEL', 'CARD', 'SWISH',
    'SWISH BREAKS', 'PACK', 'BUY A', 'GET A'
  ]);

  const raw = (Array.isArray(lines) ? lines : []).map((line) => ({
    frame: Number(line?.frame) || 0,
    text: normalizeOcrCandidate(line?.text),
    confidence: Math.max(0, Number(line?.confidence) || 0),
    area: Math.max(0, Number(line?.area) || 0),
    x: Number(line?.x),
    y: Number(line?.y)
  })).filter((line) => line.text);

  // Apple Vision often returns first and last names as separate stacked lines
  // (for example STEVE / NASH). Merge nearby 1-word lines in the same frame.
  const merged = [...raw];
  const byFrame = new Map();
  for (const line of raw) {
    if (!byFrame.has(line.frame)) byFrame.set(line.frame, []);
    byFrame.get(line.frame).push(line);
  }

  for (const frameLines of byFrame.values()) {
    for (let i = 0; i < frameLines.length; i += 1) {
      const a = frameLines[i];
      if (a.text.split(' ').length !== 1 || a.text.length < 2) continue;
      for (let j = i + 1; j < frameLines.length; j += 1) {
        const b = frameLines[j];
        if (b.text.split(' ').length !== 1 || b.text.length < 2) continue;
        if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;

        const horizontalGap = Math.abs(a.x - b.x);
        const verticalGap = Math.abs(a.y - b.y);
        if (horizontalGap > 0.12 || verticalGap > 0.12) continue;

        const top = a.y >= b.y ? a : b;
        const bottom = top === a ? b : a;
        merged.push({
          frame: a.frame,
          text: `${top.text} ${bottom.text}`,
          confidence: (a.confidence + b.confidence) / 2,
          area: a.area + b.area,
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2
        });
      }
    }
  }

  const grouped = new Map();
  for (const line of merged) {
    const text = line.text;
    if (!text || text.length < 4 || text.length > 40) continue;
    const upper = text.toUpperCase();
    if (blocked.has(upper)) continue;
    if (/\b(?:TOPPS|PANINI|PRIZM|CHROME|ROOKIE|AUTOGRAPH|REFRACTOR|BOWMAN|DONRUSS|SELECT|OPTIC|SWISH|PACK)\b/i.test(text)) continue;

    const words = text.split(' ').filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (words.some((word) => word.length < 2)) continue;
    if (!words.every((word) => /^[A-Za-z.'’\-]+$/.test(word))) continue;

    const key = upper.replace(/[.'’\-]/g, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;

    const previous = grouped.get(key) || {
      text,
      frames: new Set(),
      confidence: 0,
      area: 0,
      centerBonus: 0,
      lowerHalfBonus: 0,
      samples: 0
    };

    previous.frames.add(line.frame);
    previous.confidence += line.confidence;
    previous.area += line.area;
    previous.samples += 1;

    if (Number.isFinite(line.x)) {
      // The held-up card is usually centered; signage/background text is often wider/off-center.
      previous.centerBonus += Math.max(0, 1 - Math.abs(0.5 - line.x) * 3);
    }
    if (Number.isFinite(line.y)) {
      // Player names on cards are commonly in the center/lower region of the card.
      previous.lowerHalfBonus += line.y < 0.62 ? 0.35 : 0;
    }

    grouped.set(key, previous);
  }

  const ranked = [...grouped.values()].map((candidate) => {
    const repeats = candidate.frames.size;
    const avgConfidence = candidate.confidence / Math.max(1, candidate.samples);
    const score =
      repeats * 4.5 +
      avgConfidence * 2.2 +
      Math.min(candidate.area * 60, 3.5) +
      candidate.centerBonus * 0.9 +
      candidate.lowerHalfBonus;
    return { ...candidate, repeats, avgConfidence, score };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return { status: 'needs_review', player: '', confidence: 0, source: 'apple-vision-ocr' };

  const confidence = Math.max(0, Math.min(1,
    (best.repeats >= 2 ? 0.74 : 0.56) +
    Math.min(best.avgConfidence, 1) * 0.16 +
    Math.min(best.area * 10, 0.1)
  ));

  // A single-frame result can still be accepted when the text itself is very clear
  // and large/central. This helps with brief card reveals.
  if (best.repeats < 2 && (confidence < 0.68 || best.avgConfidence < 0.72)) {
    return { status: 'needs_review', player: '', confidence, source: 'apple-vision-ocr' };
  }

  const player = best.text
    .split(' ')
    .map((word) => word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word)
    .join(' ')
    .replace(/\bMc([a-z])/g, (_m, c) => `Mc${c.toUpperCase()}`);

  return { status: 'matched', player, confidence, source: 'apple-vision-ocr' };
}

async function extractClipPlayer(videoPath) {
  if (process.platform !== 'darwin' || !videoPath || !fs.existsSync(videoPath)) {
    return {
      status: 'unavailable',
      player: '',
      confidence: 0,
      source: 'apple-vision-ocr',
      diagnostics: {
        stage: 'preflight',
        framesAttempted: 0,
        framesCaptured: 0,
        ocrLineCount: 0,
        topText: [],
        error: process.platform !== 'darwin' ? 'Apple Vision OCR requires macOS.' : 'Replay file was unavailable.'
      }
    };
  }

  const helperPath = app.isPackaged
    ? path.join(process.resourcesPath, 'vision-ocr')
    : path.join(__dirname, 'native', 'vision-ocr');

  if (!fs.existsSync(helperPath)) {
    return {
      status: 'unavailable',
      player: '',
      confidence: 0,
      source: 'apple-vision-ocr',
      error: 'Vision OCR helper is unavailable.',
      diagnostics: {
        stage: 'helper',
        framesAttempted: 0,
        framesCaptured: 0,
        ocrLineCount: 0,
        topText: [],
        error: 'Vision OCR helper is unavailable.'
      }
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swish-clip-ocr-'));
  const frameWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  try {
    await frameWindow.loadFile('frame-extractor.html');
    const fileUrl = pathToFileURL(videoPath).href;
    const duration = Number(await frameWindow.webContents.executeJavaScript(
      `window.swishFrameExtractor.load(${JSON.stringify(fileUrl)})`
    ));
    const ratios = [0.08, 0.2, 0.32, 0.45, 0.58, 0.7, 0.82, 0.9, 0.96];

    if (!Number.isFinite(duration) || duration <= 0) {
      return {
        status: 'needs_review',
        player: '',
        confidence: 0,
        source: 'apple-vision-ocr',
        diagnostics: {
          stage: 'video-metadata',
          framesAttempted: ratios.length,
          framesCaptured: 0,
          ocrLineCount: 0,
          topText: [],
          error: 'Replay duration could not be read.'
        }
      };
    }

    const framePaths = [];

    for (let index = 0; index < ratios.length; index += 1) {
      const seconds = Math.max(0, Math.min(duration - 0.1, duration * ratios[index]));
      await frameWindow.webContents.executeJavaScript(
        `window.swishFrameExtractor.seek(${JSON.stringify(seconds)})`
      );
      const image = await frameWindow.webContents.capturePage();
      const resized = image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image;
      const framePath = path.join(tempDir, `frame-${index + 1}.jpg`);
      fs.writeFileSync(framePath, resized.toJPEG(82));
      framePaths.push(framePath);
    }

    const result = await execFileText(helperPath, framePaths, 25000);
    if (!result.ok) {
      const error = (result.stderr || result.error?.message || 'Local OCR failed.').slice(0, 300);
      return {
        status: 'error',
        player: '',
        confidence: 0,
        source: 'apple-vision-ocr',
        error,
        diagnostics: {
          stage: 'vision-ocr',
          framesAttempted: ratios.length,
          framesCaptured: framePaths.length,
          ocrLineCount: 0,
          topText: [],
          error
        }
      };
    }

    let lines = [];
    let parseError = '';
    try {
      lines = JSON.parse(result.stdout || '[]');
      if (!Array.isArray(lines)) lines = [];
    } catch (err) {
      parseError = `Unable to parse OCR output: ${err.message}`;
      lines = [];
    }

    const topText = [...lines]
      .map((line) => ({
        text: normalizeOcrCandidate(line?.text),
        confidence: Math.max(0, Number(line?.confidence) || 0),
        area: Math.max(0, Number(line?.area) || 0)
      }))
      .filter((line) => line.text)
      .sort((a, b) => (b.confidence * (1 + b.area * 20)) - (a.confidence * (1 + a.area * 20)))
      .map((line) => line.text)
      .filter((text, index, all) => all.findIndex((value) => value.toUpperCase() === text.toUpperCase()) === index)
      .slice(0, 12);

    const recognition = likelyPlayerNameFromOcr(lines);
    return {
      ...recognition,
      diagnostics: {
        stage: parseError ? 'ocr-parse' : 'complete',
        framesAttempted: ratios.length,
        framesCaptured: framePaths.length,
        ocrLineCount: lines.length,
        topText,
        error: parseError
      }
    };
  } finally {
    if (!frameWindow.isDestroyed()) frameWindow.destroy();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
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
    extractClipPlayer,
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
  ipcMain.handle('control:fetch', (_event, request) => controlFetch(request));
  ipcMain.handle('app:open-external', async (_event, rawUrl) => {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') {
      throw new Error('External sign-in URL was blocked.');
    }
    await shell.openExternal(url.href);
    return true;
  });
  ipcMain.handle('app:save-config', (_event, patch) => {
    const allowed = {
      role: ['wall', 'control', 'agent'].includes(patch?.role) ? patch.role : (patch?.role === '' ? '' : undefined),
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
    const cleanArgs = process.argv.slice(1).filter((arg) => arg !== '--reset-role');
    app.relaunch({ args: cleanArgs });
    app.exit(0);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
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
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
