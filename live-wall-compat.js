// Swish Control V2 Live Wall compatibility layer.
//
// The public-stream wall is intentionally based on the known-good V1.3
// lifecycle. V2 is allowed to decorate the wall with health/status data, but
// background telemetry must never destroy or recreate stream webviews.

const liveWallCompatState = {
  visibleSignature: '',
  exitButton: null
};

function wallVisibleStreams() {
  return streams.filter(streamMatchesFilter);
}

function wallSignature(list = wallVisibleStreams()) {
  return list.map((stream) => stream.id).join('|');
}

function createLegacyStreamWebview(stream) {
  const url = safeUrl(stream.url);
  if (!url) return null;

  const view = document.createElement('webview');
  view.src = url;
  view.setAttribute('partition', 'persist:swish-live-wall');

  const ua = userAgentFor(url);
  view.setAttribute('useragent', ua);
  view.setAttribute(
    'webpreferences',
    'contextIsolation=yes,nodeIntegration=no,sandbox=yes,spellcheck=no,backgroundThrottling=yes'
  );

  view.addEventListener('dom-ready', () => {
    try {
      view.setAudioMuted(true);
      view.setUserAgent(ua);
      view.executeJavaScript(`
        (() => {
          document.querySelectorAll('video').forEach((video) => {
            video.muted = true;
            video.disablePictureInPicture = true;
          });
        })();
      `).catch(() => {});
    } catch (_) {}
  });

  return view;
}

// Make the V1.3-compatible webview constructor the one used by both Live Wall
// and the selected-room preview.
createStreamWebview = createLegacyStreamWebview;

function buildLegacyWallTile(stream) {
  const status = statusForRoom(stream.roomId);
  const tile = document.createElement('section');
  tile.className = `stream-tile health-${status.health}${shouldPulse(status) ? ' new-critical' : ''}`;
  tile.dataset.streamId = stream.id;
  tile.dataset.roomId = stream.roomId || '';

  const header = document.createElement('div');
  header.className = 'stream-head';

  const identity = document.createElement('div');
  identity.className = 'stream-identity';
  identity.innerHTML = `
    <span class="status-dot ${escapeHtml(status.health)}"></span>
    <span class="stream-name">${escapeHtml(stream.name)}</span>
  `;

  const controls = document.createElement('div');
  controls.className = 'stream-controls';

  const refresh = document.createElement('button');
  refresh.className = 'micro-btn';
  refresh.textContent = '↻';
  refresh.title = 'Refresh this stream';
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    tile.querySelector('webview')?.reload();
  });

  const focus = document.createElement('button');
  focus.className = 'micro-btn';
  focus.textContent = '⛶';
  focus.title = 'Enlarge this stream';
  focus.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFullscreen(stream.id);
  });

  controls.append(refresh, focus);
  header.append(identity, controls);
  tile.append(header);

  const url = safeUrl(stream.url);
  if (url) {
    const stage = document.createElement('div');
    stage.className = 'phone-stage';

    const frame = document.createElement('div');
    frame.className = 'phone-frame';

    const view = createLegacyStreamWebview(stream);
    if (view) frame.append(view);

    stage.append(frame);
    tile.append(stage);
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty-stream';
    empty.textContent = 'NO STREAM URL';
    tile.append(empty);
  }

  if (['warning', 'critical', 'offline'].includes(status.health) && status.issue) {
    const issue = document.createElement('div');
    issue.className = `wall-issue ${status.health}`;
    issue.textContent = status.issue;
    tile.append(issue);
  }

  return tile;
}

// V1.3 rule: render only when the wall configuration itself changes. Health
// polling uses updateWallStatusDecorations() and never calls this function
// unless a Critical filter actually gains/loses a stream.
renderWall = function renderWallCompat() {
  if (currentPage !== 'wall') return;

  exitCompatFullscreen(false);
  const visibleStreams = wallVisibleStreams();
  liveWallCompatState.visibleSignature = wallSignature(visibleStreams);

  els.wallGrid.innerHTML = '';
  visibleStreams.forEach((stream) => els.wallGrid.append(buildLegacyWallTile(stream)));

  if (!visibleStreams.length) {
    els.wallGrid.innerHTML = '<div class="empty-state">No streams match this filter.</div>';
  }
};

updateWallStatusDecorations = function updateWallStatusCompat() {
  if (currentPage !== 'wall') return;

  // Critical is the only filter whose membership can change from telemetry.
  // Rebuild only on that actual membership transition, not every heartbeat.
  if (activeFilter === 'Critical') {
    const nextSignature = wallSignature();
    if (nextSignature !== liveWallCompatState.visibleSignature) {
      renderWall();
      return;
    }
  }

  els.wallGrid.querySelectorAll('.stream-tile').forEach((tile) => {
    const stream = streams.find((candidate) => candidate.id === tile.dataset.streamId);
    if (!stream) return;

    const status = statusForRoom(stream.roomId);
    ['healthy', 'warning', 'critical', 'offline', 'unmonitored'].forEach((health) => {
      tile.classList.remove(`health-${health}`);
    });
    tile.classList.add(`health-${status.health}`);
    tile.classList.toggle('new-critical', shouldPulse(status));

    const dot = tile.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${status.health}`;

    tile.querySelector('.wall-issue')?.remove();
    if (['warning', 'critical', 'offline'].includes(status.health) && status.issue) {
      const issue = document.createElement('div');
      issue.className = `wall-issue ${status.health}`;
      issue.textContent = status.issue;
      tile.append(issue);
    }
  });
};

// No backend configured means there is simply no status data yet. It must not
// cause the Live Wall to render again.
refreshWallStatuses = async function refreshWallStatusesCompat() {
  if (!appConfig.serverUrl) {
    if (wallStatuses.size) {
      wallStatuses = new Map();
      updateWallStatusDecorations();
    }
    return;
  }

  try {
    const data = await fetchJson('/api/wall-status', { auth: false }, 4000);
    wallStatuses = new Map((data.rooms || []).map((room) => [room.roomId, room]));
    renderRoomOptions();
    updateWallStatusDecorations();
    if (currentPage === 'overview' && authToken) renderOverview();
  } catch (_) {
    // Server/status failure must never interrupt the public streams.
  }
};

function ensureCompatExitButton() {
  if (liveWallCompatState.exitButton?.isConnected) return liveWallCompatState.exitButton;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '← EXIT FULLSCREEN';
  button.title = 'Return to Live Wall';
  button.style.cssText = [
    'position:fixed',
    'top:68px',
    'left:14px',
    'z-index:1000',
    'height:34px',
    'padding:0 12px',
    'border:1px solid rgba(255,255,255,.2)',
    'border-radius:8px',
    'background:rgba(7,9,13,.94)',
    'color:white',
    'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:10px',
    'font-weight:800',
    'letter-spacing:.04em',
    'cursor:pointer',
    'box-shadow:0 8px 30px rgba(0,0,0,.4)'
  ].join(';');
  button.addEventListener('click', () => exitCompatFullscreen(true));
  document.body.append(button);
  liveWallCompatState.exitButton = button;
  return button;
}

function exitCompatFullscreen(resume = true) {
  fullscreenStreamId = null;
  document.body.classList.remove('focus-mode');
  els.wallGrid?.querySelectorAll('.stream-tile').forEach((tile) => tile.classList.remove('fullscreen'));
  liveWallCompatState.exitButton?.remove();
  liveWallCompatState.exitButton = null;
  if (resume) activeWebviews().forEach(resumeView);
}

toggleFullscreen = function toggleFullscreenCompat(streamId) {
  const tiles = [...els.wallGrid.querySelectorAll('.stream-tile')];

  if (fullscreenStreamId === streamId) {
    exitCompatFullscreen(true);
    return;
  }

  // Always normalize first. This keeps repeated focus changes deterministic.
  exitCompatFullscreen(false);
  fullscreenStreamId = streamId;
  document.body.classList.add('focus-mode');

  tiles.forEach((tile) => {
    const selected = tile.dataset.streamId === streamId;
    tile.classList.toggle('fullscreen', selected);
    const view = tile.querySelector('webview');
    if (!view) return;
    if (selected) resumeView(view);
    else pauseView(view);
  });

  ensureCompatExitButton();
};

// Leaving Live Wall must always unwind focus mode before another page takes
// over. The rest of V2 navigation remains unchanged.
const v2SwitchPage = switchPage;
switchPage = function switchPageCompat(page) {
  if (page !== 'wall') exitCompatFullscreen(true);
  return v2SwitchPage(page);
};

// Escape remains supported, but it is no longer the only escape hatch.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && fullscreenStreamId) {
    event.preventDefault();
    event.stopImmediatePropagation();
    exitCompatFullscreen(true);
  }
}, true);
