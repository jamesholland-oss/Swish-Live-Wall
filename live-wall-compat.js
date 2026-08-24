// Swish Control V2 Live Wall compatibility layer.
//
// The Live Wall is treated as a long-lived V1.3-style module. The public
// stream webviews remain mounted for the life of the app so navigating through
// Overview / Rooms / Incidents or changing filters cannot wipe site login or
// in-page state. V2 may decorate tiles with health data, but telemetry never
// owns the stream lifecycle.

const liveWallCompatState = {
  configSignature: '',
  exitButton: null
};

function wallConfigSignature() {
  return streams.map((stream) => [
    stream.id,
    stream.name,
    stream.url,
    stream.platform,
    stream.roomId
  ].join('::')).join('|');
}

function wallViews() {
  return [...els.wallGrid.querySelectorAll('.stream-tile webview')];
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

// Use the proven V1.3 webview constructor for both the wall and the selected
// room preview.
createStreamWebview = createLegacyStreamWebview;

function buildLegacyWallTile(stream) {
  const status = statusForRoom(stream.roomId);
  const tile = document.createElement('section');
  tile.className = `stream-tile health-${status.health}${shouldPulse(status) ? ' new-critical' : ''}`;
  tile.dataset.streamId = stream.id;
  tile.dataset.roomId = stream.roomId || '';
  tile.dataset.platform = platformFor(stream);

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

function tileMatchesActiveFilter(tile) {
  if (activeFilter === 'All') return true;

  const stream = streams.find((candidate) => candidate.id === tile.dataset.streamId);
  if (!stream) return false;

  if (activeFilter === 'Critical') {
    const status = statusForRoom(stream.roomId);
    return status.health === 'critical' || status.health === 'offline';
  }

  return platformFor(stream) === activeFilter;
}

function applyWallFilterWithoutReload() {
  let visibleCount = 0;

  els.wallGrid.querySelectorAll('.stream-tile').forEach((tile) => {
    const visible = tileMatchesActiveFilter(tile);
    tile.classList.toggle('filter-hidden', !visible);
    if (visible) visibleCount += 1;
  });

  let empty = els.wallGrid.querySelector('.wall-filter-empty');
  if (!visibleCount) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty-state wall-filter-empty';
      empty.textContent = 'No streams match this filter.';
      els.wallGrid.append(empty);
    }
  } else {
    empty?.remove();
  }
}

// Render/recreate webviews only when stream configuration itself changes.
// Navigating tabs, receiving health updates and changing filters do not rebuild.
renderWall = function renderWallCompat() {
  const signature = wallConfigSignature();
  const alreadyBuilt = els.wallGrid.querySelectorAll('.stream-tile').length > 0;

  if (!alreadyBuilt || signature !== liveWallCompatState.configSignature) {
    exitCompatFullscreen(false);
    els.wallGrid.innerHTML = '';
    streams.forEach((stream) => els.wallGrid.append(buildLegacyWallTile(stream)));
    liveWallCompatState.configSignature = signature;
  }

  applyWallFilterWithoutReload();
  updateWallStatusDecorations();
};

updateWallStatusDecorations = function updateWallStatusCompat() {
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

  // Health can change membership of the Critical filter. Hide/show only.
  if (activeFilter === 'Critical') applyWallFilterWithoutReload();
};

// No backend configured means simply no status data yet. Never touch webviews.
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
    // Status server failure must never interrupt public streams.
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
  if (resume) wallViews().forEach(resumeView);
}

toggleFullscreen = function toggleFullscreenCompat(streamId) {
  const tiles = [...els.wallGrid.querySelectorAll('.stream-tile')];

  if (fullscreenStreamId === streamId) {
    exitCompatFullscreen(true);
    return;
  }

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

// Replace V2 page rendering so the wall DOM is never cleared while the app is
// open. We only hide its page and pause its media while another control page is
// visible. Returning to Live Wall resumes the same webviews and page sessions.
renderCurrentPage = function renderCurrentPageCompat() {
  if (currentPage === 'wall') {
    renderFilters();
    renderWall();
    wallViews().forEach(resumeView);
    return;
  }

  wallViews().forEach(pauseView);

  if (currentPage === 'overview') renderOverview();
  if (currentPage === 'rooms') renderRooms();
  if (currentPage === 'incidents') renderIncidents();
};

const v2SwitchPage = switchPage;
switchPage = function switchPageCompat(page) {
  if (page !== 'wall') exitCompatFullscreen(false);
  return v2SwitchPage(page);
};

// Escape remains supported, but it is no longer the only exit route.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && fullscreenStreamId) {
    event.preventDefault();
    event.stopImmediatePropagation();
    exitCompatFullscreen(true);
  }
}, true);
