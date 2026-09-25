// Swish Control V2 Live Wall compatibility layer.
//
// The Live Wall is treated as a long-lived V1.3-style module. The public
// stream webviews remain mounted for the life of the app so navigating through
// Overview / Rooms / Incidents or changing filters cannot wipe site login or
// in-page state. V2 may decorate tiles with health data, but telemetry never
// owns the stream lifecycle.

const FANATICS_SHOP_URL = 'https://www.fanatics.live/shops/swish-breaks';

const liveWallCompatState = {
  configSignature: '',
  exitButton: null,
  audioMutedByStream: new Map(),
  roomPortal: null,
  fanaticsResolveTimers: new Map()
};

function wallConfigSignature() {
  // Room assignment is metadata only. Do not include roomId here because
  // linking a stream to a monitored room must never recreate the provider
  // webview/session.
  return streams.map((stream) => [
    stream.id,
    stream.name,
    stream.url,
    stream.platform
  ].join('::')).join('|');
}

function wallViews() {
  return [...els.wallGrid.querySelectorAll('.stream-tile webview')];
}

function restorePortaledWallStream() {
  const portal = liveWallCompatState.roomPortal;
  if (!portal) return;

  const { frame, placeholder } = portal;
  try {
    frame.classList.remove('room-phone-frame', 'room-linked-wall-frame');
    delete frame.dataset.platform;
    if (placeholder?.parentNode) {
      placeholder.parentNode.insertBefore(frame, placeholder);
      placeholder.remove();
    }
  } catch (_) {}

  liveWallCompatState.roomPortal = null;
  if (currentPage === 'wall') resumeView(frame.querySelector('webview'));
}

function mountLinkedWallStreamInRoom(stream, stage) {
  if (!stream?.id || !stage) return false;

  const current = liveWallCompatState.roomPortal;
  if (current?.streamId === stream.id && current.frame?.isConnected) {
    if (current.frame.parentNode !== stage) stage.append(current.frame);
    current.frame.classList.add('room-phone-frame', 'room-linked-wall-frame');
    current.frame.dataset.platform = platformFor(stream);
    resumeView(current.frame.querySelector('webview'));
    return true;
  }

  restorePortaledWallStream();

  const tile = els.wallGrid.querySelector(
    `.stream-tile[data-stream-id="${CSS.escape(stream.id)}"]`
  );
  const frame = tile?.querySelector('.phone-frame');
  const originalStage = frame?.parentNode;
  if (!frame || !originalStage) return false;

  const placeholder = document.createComment(`swish-room-portal:${stream.id}`);
  originalStage.insertBefore(placeholder, frame);

  frame.classList.add('room-phone-frame', 'room-linked-wall-frame');
  frame.dataset.platform = platformFor(stream);
  stage.append(frame);

  liveWallCompatState.roomPortal = {
    streamId: stream.id,
    frame,
    placeholder
  };

  resumeView(frame.querySelector('webview'));
  return true;
}

function streamMuted(streamId) {
  return liveWallCompatState.audioMutedByStream.has(streamId)
    ? liveWallCompatState.audioMutedByStream.get(streamId)
    : true;
}

function applyStreamAudioState(view, muted) {
  if (!view) return;
  try { view.setAudioMuted(Boolean(muted)); } catch (_) {}
  try {
    view.executeJavaScript(`
      (() => {
        document.querySelectorAll('video,audio').forEach((media) => {
          media.muted = ${muted ? 'true' : 'false'};
          if (!${muted ? 'true' : 'false'} && media.volume === 0) media.volume = 1;
          if (media instanceof HTMLVideoElement) media.disablePictureInPicture = true;
        });
      })();
    `).catch(() => {});
  } catch (_) {}
}

function updateAudioButton(tile, muted) {
  const button = tile?.querySelector('.audio-toggle');
  if (!button) return;
  button.textContent = muted ? '🔇' : '🔊';
  button.title = muted ? 'Unmute this stream' : 'Mute this stream';
  button.setAttribute('aria-label', button.title);
}

function setStreamMuted(streamId, muted) {
  liveWallCompatState.audioMutedByStream.set(streamId, Boolean(muted));
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(streamId)}"]`);
  const view = tile?.querySelector('webview');
  applyStreamAudioState(view, Boolean(muted));
  updateAudioButton(tile, Boolean(muted));
}

function streamTelemetryState(stream) {
  if (!stream?.roomId) return 'unknown';
  const status = statusForRoom(stream.roomId);
  if (status?.agentOnline === false) return 'unknown';
  if (status?.streamingActive === true) return 'live';
  if (status?.streamingActive === false) return 'off';
  return 'unknown';
}

function ensureOffAirOverlay(tile, stream, title = 'NO STREAM RIGHT NOW', subtitle = '') {
  let overlay = tile?.querySelector('.stream-off-air');
  const stage = tile?.querySelector('.phone-stage');
  if (!stage) return null;

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'stream-off-air';
    stage.append(overlay);
  }

  const fallbackSubtitle = `${stream.name} will return here automatically when OBS goes live.`;
  overlay.innerHTML = `
    <div class="stream-off-air-inner">
      <div class="stream-off-air-kicker">SWISH CONTROL</div>
      <div class="stream-off-air-title">${escapeHtml(title)}</div>
      <div class="stream-off-air-subtitle">${escapeHtml(subtitle || fallbackSubtitle)}</div>
    </div>
  `;
  return overlay;
}

function fanaticsChannelCode(stream) {
  const name = String(stream?.name || '').toLowerCase();
  if (name.includes('wax')) return 'SW';
  if (name.includes('bats')) return 'SB';
  if (name.includes('breaks') || name.includes('main')) return 'SM';
  return '';
}

function currentViewUrl(view) {
  try { return String(view?.getURL?.() || ''); }
  catch (_) { return ''; }
}

function loadFanaticsShop(view) {
  if (!view?.isConnected) return;
  const current = currentViewUrl(view);
  if (current.startsWith(FANATICS_SHOP_URL)) return;
  try {
    view.dataset.swishFanaticsResolvedUrl = '';
    view.loadURL(FANATICS_SHOP_URL);
  } catch (_) {}
}

function scheduleFanaticsResolution(view, stream, tile, delayMs = 500) {
  if (!view || !stream?.id) return;
  const existing = liveWallCompatState.fanaticsResolveTimers.get(stream.id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    liveWallCompatState.fanaticsResolveTimers.delete(stream.id);
    resolveFanaticsCurrentShow(view, stream, tile).catch(() => {});
  }, delayMs);
  liveWallCompatState.fanaticsResolveTimers.set(stream.id, timer);
}

async function resolveFanaticsCurrentShow(view, stream, tile) {
  if (!view?.isConnected || platformFor(stream) !== 'Fanatics' || !stream.roomId) return;

  const liveState = streamTelemetryState(stream);
  if (liveState !== 'live') {
    const title = liveState === 'unknown' ? 'CHECKING LIVE STATUS' : 'NO STREAM RIGHT NOW';
    const subtitle = liveState === 'unknown'
      ? 'Waiting for the room agent before showing a Fanatics stream.'
      : `${stream.name} will appear automatically when this room goes live.`;
    ensureOffAirOverlay(tile, stream, title, subtitle);
    loadFanaticsShop(view);
    pauseView(view);
    return;
  }

  const resolvedUrl = String(view.dataset.swishFanaticsResolvedUrl || '');
  const current = currentViewUrl(view);

  if (resolvedUrl && current && current.split('?')[0] === resolvedUrl.split('?')[0]) {
    tile.querySelector('.stream-off-air')?.remove();
    resumeView(view);
    return;
  }

  ensureOffAirOverlay(
    tile,
    stream,
    'FINDING LIVE STREAM',
    `Looking for the current ${stream.name} show on Fanatics.`
  );

  if (!current.startsWith(FANATICS_SHOP_URL)) {
    loadFanaticsShop(view);
    return;
  }

  const code = fanaticsChannelCode(stream);
  if (!code) {
    ensureOffAirOverlay(tile, stream, 'NO STREAM RIGHT NOW', 'No Fanatics channel mapping is configured for this room.');
    return;
  }

  if (view.dataset.swishFanaticsResolving === '1') return;
  view.dataset.swishFanaticsResolving = '1';

  try {
    const match = await view.executeJavaScript(`
      (() => {
        const code = ${JSON.stringify(code)};
        const codePattern = new RegExp('\\\\(' + code + '\\\\)|\\\\b' + code + '\\\\b', 'i');
        const items = Array.from(document.querySelectorAll('[data-role="show-item"]'));

        for (const item of items) {
          const id = item.getAttribute('id') || '';
          if (!id.startsWith('live-show-')) continue;

          const titleNode = item.querySelector('[class*="line-clamp-2"][class*="break-words"]');
          const ariaLabel = item.getAttribute('aria-label') || '';
          const title = (titleNode?.textContent || ariaLabel || '').trim();
          if (!codePattern.test(title)) continue;

          const href = item.getAttribute('href') || item.href || '';
          if (!href) continue;
          return new URL(href, location.origin).href;
        }

        return '';
      })();
    `);

    const showUrl = String(match || '').trim();
    if (!showUrl) {
      ensureOffAirOverlay(
        tile,
        stream,
        'NO STREAM RIGHT NOW',
        `OBS is live, but Fanatics has not published a live ${stream.name} show yet.`
      );
      scheduleFanaticsResolution(view, stream, tile, 4000);
      return;
    }

    view.dataset.swishFanaticsResolvedUrl = showUrl;
    try { view.loadURL(showUrl); } catch (_) {}
  } catch (_) {
    scheduleFanaticsResolution(view, stream, tile, 4000);
  } finally {
    view.dataset.swishFanaticsResolving = '';
  }
}

function updateStreamLivePresentation(tile, stream) {
  if (!tile || !stream) return;
  const next = streamTelemetryState(stream);
  const previous = tile.dataset.liveState || 'unknown';
  const view = tile.querySelector('webview');
  const linkedRoom = Boolean(stream.roomId);
  tile.dataset.liveState = next;

  // Every linked room is agent-gated. If the room is not streaming, the Wall
  // and Room View show a clean off-air state instead of stale provider content.
  if (linkedRoom && next === 'unknown') {
    ensureOffAirOverlay(
      tile,
      stream,
      'CHECKING LIVE STATUS',
      'Waiting for the room agent before showing this stream.'
    );
    pauseView(view);
    return;
  }

  if (linkedRoom && next === 'off') {
    ensureOffAirOverlay(
      tile,
      stream,
      'NO STREAM RIGHT NOW',
      `${stream.name} will return here automatically when this room goes live.`
    );

    if (platformFor(stream) === 'Fanatics') {
      view && (view.dataset.swishFanaticsResolvedUrl = '');
      loadFanaticsShop(view);
    }

    pauseView(view);
    return;
  }

  // Linked Fanatics rooms need one extra step while live: resolve the current
  // matching show from the Swish Fanatics shop and block random redirects.
  if (platformFor(stream) === 'Fanatics' && linkedRoom) {
    resolveFanaticsCurrentShow(view, stream, tile).catch(() => {});
    return;
  }

  if (next === 'live') {
    tile.querySelector('.stream-off-air')?.remove();

    // A provider page can be stale after an off-air period. Reload once when
    // the room transitions back to live, then leave the webview alone.
    if (linkedRoom && previous !== 'live') {
      try { view?.reload(); } catch (_) {}
    } else {
      resumeView(view);
    }
    return;
  }

  // Unlinked streams still behave like the legacy wall because there is no
  // room agent to tell us whether they are actually live.
  tile.querySelector('.stream-off-air')?.remove();
  resumeView(view);
}

function createLegacyStreamWebview(stream) {
  const url = safeUrl(stream.url);
  if (!url) return null;

  const view = document.createElement('webview');
  const initialUrl = platformFor(stream) === 'Fanatics' && stream.roomId ? FANATICS_SHOP_URL : url;
  view.src = initialUrl;
  view.setAttribute('partition', 'persist:swish-live-wall');

  const ua = userAgentFor(url);
  view.setAttribute('useragent', ua);
  view.setAttribute(
    'webpreferences',
    'contextIsolation=yes,nodeIntegration=no,sandbox=yes,spellcheck=no,backgroundThrottling=yes'
  );

  const applyProviderPresentation = () => {
    try {
      // Keep the proven V1.3 user agent/session behavior, but scale Fanatics
      // slightly smaller so its native auction UI fits like Whatnot on the
      // standard three-column wall.
      const platform = platformFor(stream);
      view.setZoomFactor(platform === 'Fanatics' ? 0.72 : platform === 'TikTok' ? 1.12 : 1);
    } catch (_) {}
  };

  view.addEventListener('dom-ready', () => {
    try {
      view.setUserAgent(ua);
      applyProviderPresentation();
      applyStreamAudioState(view, streamMuted(stream.id));
      if (platformFor(stream) === 'Fanatics' && stream.roomId) {
        const tile = view.closest('.stream-tile');
        scheduleFanaticsResolution(view, stream, tile, 800);
      }
    } catch (_) {}
  });

  view.addEventListener('did-finish-load', () => {
    applyProviderPresentation();
    applyStreamAudioState(view, streamMuted(stream.id));

    if (platformFor(stream) === 'Fanatics' && stream.roomId) {
      const tile = view.closest('.stream-tile');
      const resolvedUrl = String(view.dataset.swishFanaticsResolvedUrl || '');
      const current = currentViewUrl(view);

      if (resolvedUrl && current.split('?')[0] === resolvedUrl.split('?')[0]) {
        if (streamTelemetryState(stream) === 'live') {
          tile?.querySelector('.stream-off-air')?.remove();
          resumeView(view);
        }
      } else {
        scheduleFanaticsResolution(view, stream, tile, 800);
      }
    }
  });

  view.addEventListener('did-navigate', (event) => {
    if (platformFor(stream) !== 'Fanatics' || !stream.roomId) return;
    const resolvedUrl = String(view.dataset.swishFanaticsResolvedUrl || '');
    const nextUrl = String(event.url || '');

    // Fanatics redirects ended shows to unrelated live sellers. If that
    // happens, immediately return to our shop resolver instead of displaying it.
    if (
      resolvedUrl &&
      nextUrl.includes('/shows/') &&
      nextUrl.split('?')[0] !== resolvedUrl.split('?')[0]
    ) {
      view.dataset.swishFanaticsResolvedUrl = '';
      loadFanaticsShop(view);
    }
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

  identity.addEventListener('click', (event) => {
    const currentStream = streams.find((candidate) => candidate.id === tile.dataset.streamId);
    if (!currentStream?.roomId || !authToken || typeof userCan !== 'function' || !userCan('rooms:view')) return;
    event.stopPropagation();
    selectedRoomId = currentStream.roomId;
    switchPage('rooms');
  });

  const controls = document.createElement('div');
  controls.className = 'stream-controls';

  const audio = document.createElement('button');
  audio.className = 'micro-btn audio-toggle';
  updateAudioButton({ querySelector: () => audio }, streamMuted(stream.id));
  audio.addEventListener('click', (event) => {
    event.stopPropagation();
    setStreamMuted(stream.id, !streamMuted(stream.id));
  });

  const refresh = document.createElement('button');
  refresh.className = 'micro-btn';
  refresh.textContent = '↻';
  refresh.title = 'Refresh this stream';
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    tile.querySelector('webview')?.reload();
  });

  // Standard wall only for now: keep the controls minimal and avoid
  // switching into a separate focus layout.
  controls.append(audio, refresh);
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

  updateStreamLivePresentation(tile, stream);
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

function syncWallRoomBindings() {
  els.wallGrid.querySelectorAll('.stream-tile').forEach((tile) => {
    const stream = streams.find((candidate) => candidate.id === tile.dataset.streamId);
    if (!stream) return;

    tile.dataset.roomId = stream.roomId || '';

    const identity = tile.querySelector('.stream-identity');
    const canOpenRoom = Boolean(
      stream.roomId &&
      authToken &&
      typeof userCan === 'function' &&
      userCan('rooms:view')
    );

    identity?.classList.toggle('stream-room-link', canOpenRoom);
    if (identity) identity.title = canOpenRoom ? 'Open room dashboard' : '';
  });
}

// Render/recreate webviews only when stream configuration itself changes.
// Navigating tabs, receiving health updates, room assignment and changing
// filters do not rebuild the provider webviews.
renderWall = function renderWallCompat() {
  const signature = wallConfigSignature();
  const alreadyBuilt = els.wallGrid.querySelectorAll('.stream-tile').length > 0;

  if (!alreadyBuilt || signature !== liveWallCompatState.configSignature) {
    restorePortaledWallStream();
    exitCompatFullscreen(false);
    els.wallGrid.innerHTML = '';
    streams.forEach((stream) => els.wallGrid.append(buildLegacyWallTile(stream)));
    liveWallCompatState.configSignature = signature;
  }

  syncWallRoomBindings();
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

    updateStreamLivePresentation(tile, stream);

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
    restorePortaledWallStream();
    renderFilters();
    renderWall();
    wallViews().forEach(resumeView);
    return;
  }

  if (currentPage === 'rooms') {
    // Mount the selected Live Wall webview into the Room View first, while it
    // is still actively playing. Only pause the remaining wall feeds after the
    // selected feed has been portaled. This avoids the visible pause/rebuffer
    // that made room switching feel slow.
    renderRooms();
    wallViews().forEach(pauseView);
    const activeRoomView = liveWallCompatState.roomPortal?.frame?.querySelector('webview');
    if (activeRoomView) resumeView(activeRoomView);
    return;
  }

  restorePortaledWallStream();
  wallViews().forEach(pauseView);

  if (currentPage === 'overview') renderOverview();
  if (currentPage === 'reports' && typeof renderReports === 'function') renderReports();
  if (currentPage === 'incidents') renderIncidents();
};