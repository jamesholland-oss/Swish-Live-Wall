// Windows-only presentation and TikTok authentication compatibility.
//
// Goals:
// 1. Keep the Windows wall visually as close to the clean Mac wall as possible.
// 2. Hide Chromium scrollbar chrome without disabling normal wheel/touch scrolling.
// 3. Give TikTok a dedicated login path that shares the wall's persistent session,
//    but temporarily uses a normal desktop Chrome identity for authentication.

const SWISH_WINDOWS = /Windows/i.test(navigator.userAgent);
const WINDOWS_TIKTOK_LOGIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const WINDOWS_GUEST_CSS = [
  'html, body {',
  '  max-width: 100vw !important;',
  '  overflow-x: hidden !important;',
  '  overscroll-behavior: none !important;',
  '  scrollbar-width: none !important;',
  '  -ms-overflow-style: none !important;',
  '}',
  '* {',
  '  scrollbar-width: none !important;',
  '  -ms-overflow-style: none !important;',
  '}',
  '*::-webkit-scrollbar {',
  '  width: 0 !important;',
  '  height: 0 !important;',
  '  display: none !important;',
  '  background: transparent !important;',
  '}',
  '*::-webkit-scrollbar-thumb,',
  '*::-webkit-scrollbar-track {',
  '  background: transparent !important;',
  '}'
].join('\n');

function installWindowsHostPolish() {
  if (!SWISH_WINDOWS || document.getElementById('swish-windows-host-polish')) return;

  document.documentElement.classList.add('swish-windows');
  const style = document.createElement('style');
  style.id = 'swish-windows-host-polish';
  style.textContent = [
    '.swish-windows, .swish-windows body, .swish-windows .page, .swish-windows .wall-grid,',
    '.swish-windows .phone-stage, .swish-windows .phone-frame, .swish-windows .room-phone-frame {',
    '  scrollbar-width: none !important;',
    '  -ms-overflow-style: none !important;',
    '}',
    '.swish-windows *::-webkit-scrollbar {',
    '  width: 0 !important;',
    '  height: 0 !important;',
    '  display: none !important;',
    '}',
    '.swish-windows #wallPage {',
    '  overflow: hidden !important;',
    '  overscroll-behavior: none !important;',
    '}',
    '.swish-windows .wall-grid {',
    '  overflow: hidden !important;',
    '  overscroll-behavior: none !important;',
    '}',
    '.swish-windows .phone-stage, .swish-windows .phone-frame, .swish-windows .room-phone-frame {',
    '  overflow: hidden !important;',
    '}',
    '.swish-windows .stream-tile {',
    '  contain: paint;',
    '}',
    '.swish-windows .phone-frame webview, .swish-windows .room-phone-frame webview {',
    '  outline: 0 !important;',
    '}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

installWindowsHostPolish();

async function applyWindowsGuestPolish(view) {
  if (!SWISH_WINDOWS || !view) return;

  try {
    if (typeof view.insertCSS === 'function') await view.insertCSS(WINDOWS_GUEST_CSS);
  } catch (_) {}

  try {
    const script = `(() => {
      const id = 'swish-control-windows-polish';
      let style = document.getElementById(id);
      if (!style) {
        style = document.createElement('style');
        style.id = id;
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = ${JSON.stringify(WINDOWS_GUEST_CSS)};
      if (document.documentElement) document.documentElement.style.overflowX = 'hidden';
      if (document.body) document.body.style.overflowX = 'hidden';
    })();`;
    await view.executeJavaScript(script);
  } catch (_) {}
}

const swishCreateLegacyStreamWebview = createLegacyStreamWebview;

createLegacyStreamWebview = function createPolishedWindowsStreamWebview(stream) {
  const view = swishCreateLegacyStreamWebview(stream);
  if (!view || !SWISH_WINDOWS) return view;

  const isTikTok = platformFor(stream) === 'TikTok';
  if (isTikTok) view.setAttribute('allowpopups', '');

  const polish = () => applyWindowsGuestPolish(view);
  view.addEventListener('dom-ready', polish);
  view.addEventListener('did-finish-load', polish);
  view.addEventListener('did-navigate', polish);
  view.addEventListener('did-navigate-in-page', polish);

  return view;
};

createStreamWebview = createLegacyStreamWebview;

const swishBuildLegacyWallTile = buildLegacyWallTile;

buildLegacyWallTile = function buildWindowsCompatibleWallTile(stream) {
  const tile = swishBuildLegacyWallTile(stream);
  if (!SWISH_WINDOWS || platformFor(stream) !== 'TikTok') return tile;

  const controls = tile.querySelector('.stream-controls');
  const view = tile.querySelector('webview');
  if (!controls || !view) return tile;

  const auth = document.createElement('button');
  auth.className = 'micro-btn';
  auth.textContent = 'TT';
  auth.title = 'TikTok login';
  auth.dataset.mode = 'live';

  auth.addEventListener('click', (event) => {
    event.stopPropagation();

    if (auth.dataset.mode === 'login') {
      const liveUa = userAgentFor(stream.url);
      try { view.setUserAgent(liveUa); } catch (_) {}
      view.setAttribute('useragent', liveUa);
      view.loadURL(stream.url);
      auth.dataset.mode = 'live';
      auth.textContent = 'TT';
      auth.title = 'TikTok login';
      return;
    }

    try { view.setUserAgent(WINDOWS_TIKTOK_LOGIN_UA); } catch (_) {}
    view.setAttribute('useragent', WINDOWS_TIKTOK_LOGIN_UA);
    view.loadURL('https://www.tiktok.com/login');
    auth.dataset.mode = 'login';
    auth.textContent = 'LIVE';
    auth.title = 'Return to TikTok live stream';

    if (fullscreenStreamId !== stream.id) toggleFullscreen(stream.id);
  });

  controls.prepend(auth);
  return tile;
};