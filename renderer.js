let streams = [];
let appConfig = {};
let wallStatuses = new Map();
let controlRooms = [];
let incidents = [];
let authToken = '';
let authUser = null;
let selectedRoomId = '';
let currentPage = 'wall';
let activeFilter = 'All';
let fullscreenStreamId = null;
let wallPollTimer = null;
let controlPollTimer = null;
let pendingRole = '';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const $ = (id) => document.getElementById(id);

const els = {
  techNav: $('techNav'),
  signInBtn: $('signInBtn'),
  profileBtn: $('profileBtn'),
  overviewPage: $('overviewPage'),
  wallPage: $('wallPage'),
  roomsPage: $('roomsPage'),
  incidentsPage: $('incidentsPage'),
  overviewSummary: $('overviewSummary'),
  overviewRooms: $('overviewRooms'),
  platformFilters: $('platformFilters'),
  wallGrid: $('wallGrid'),
  refreshAllBtn: $('refreshAllBtn'),
  manageStreamsBtn: $('manageStreamsBtn'),
  roomsList: $('roomsList'),
  roomDetail: $('roomDetail'),
  incidentsBody: $('incidentsBody'),
  incidentCount: $('incidentCount'),
  setupModal: $('setupModal'),
  setupFields: $('setupFields'),
  setupServerUrl: $('setupServerUrl'),
  setupRoomWrap: $('setupRoomWrap'),
  setupRoomName: $('setupRoomName'),
  setupKeyWrap: $('setupKeyWrap'),
  setupEnrollmentKey: $('setupEnrollmentKey'),
  setupObsPasswordWrap: $('setupObsPasswordWrap'),
  setupObsPassword: $('setupObsPassword'),
  setupBackBtn: $('setupBackBtn'),
  setupSaveBtn: $('setupSaveBtn'),
  loginModal: $('loginModal'),
  loginEmail: $('loginEmail'),
  loginPassword: $('loginPassword'),
  loginError: $('loginError'),
  loginCancelBtn: $('loginCancelBtn'),
  loginSubmitBtn: $('loginSubmitBtn'),
  streamsModal: $('streamsModal'),
  streamRows: $('streamRows'),
  streamsCloseBtn: $('streamsCloseBtn'),
  streamsCancelBtn: $('streamsCancelBtn'),
  streamsSaveBtn: $('streamsSaveBtn'),
  addStreamBtn: $('addStreamBtn'),
  roomOptions: $('roomOptions')
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function normalizeServerUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function userAgentFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'whatnot.com' || host.endsWith('.whatnot.com')) return DESKTOP_UA;
  } catch (_) {}
  return MOBILE_UA;
}

function statusForRoom(roomId) {
  if (!roomId) return { health: 'unmonitored', issue: '', changedAt: null };
  return wallStatuses.get(roomId) || { health: 'unmonitored', issue: '', changedAt: null };
}

function statusLabel(health) {
  if (health === 'healthy') return 'Healthy';
  if (health === 'warning') return 'Warning';
  if (health === 'critical') return 'Critical';
  if (health === 'offline') return 'Offline';
  return 'Unlinked';
}

function shouldPulse(status) {
  if (status.health !== 'critical') return false;
  if (!status.changedAt) return false;
  const changed = Date.parse(status.changedAt);
  return Number.isFinite(changed) && Date.now() - changed < 60000;
}

function platformFor(stream) {
  if (stream.platform) return stream.platform;
  try {
    const host = new URL(stream.url).hostname.toLowerCase();
    if (host.includes('fanatics')) return 'Fanatics';
    if (host.includes('whatnot')) return 'Whatnot';
    if (host.includes('tiktok')) return 'TikTok';
  } catch (_) {}
  return 'Other';
}

function activeWebviews() {
  return [...document.querySelectorAll('webview')];
}

function pauseView(view) {
  if (!view?.executeJavaScript) return;
  view.executeJavaScript(`
    (() => {
      document.querySelectorAll('video,audio').forEach((el) => {
        if (!el.paused) {
          el.dataset.swishWasPlaying = '1';
          el.pause();
        }
      });
    })();
  `).catch(() => {});
}

function resumeView(view) {
  if (!view?.executeJavaScript) return;
  view.executeJavaScript(`
    (() => {
      document.querySelectorAll('video,audio').forEach((el) => {
        if (el.dataset.swishWasPlaying === '1') {
          delete el.dataset.swishWasPlaying;
          el.play().catch(() => {});
        }
      });
    })();
  `).catch(() => {});
}

function createStreamWebview(stream) {
  const url = safeUrl(stream.url);
  if (!url) return null;

  const view = document.createElement('webview');
  const ua = userAgentFor(url);
  view.src = url;
  view.setAttribute('partition', 'persist:swish-live-wall');
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

async function fetchJson(path, options = {}, timeoutMs = 5000) {
  const serverUrl = normalizeServerUrl(appConfig.serverUrl);
  if (!serverUrl) throw new Error('Server URL is not configured.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    if (options.auth !== false && authToken) headers.authorization = `Bearer ${authToken}`;

    const response = await fetch(`${serverUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Server returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshWallStatuses() {
  if (!appConfig.serverUrl) {
    wallStatuses = new Map();
    renderCurrentPage();
    return;
  }

  try {
    const data = await fetchJson('/api/wall-status', { auth: false }, 4000);
    wallStatuses = new Map((data.rooms || []).map((room) => [room.roomId, room]));
    renderRoomOptions();
    if (currentPage === 'wall') updateWallStatusDecorations();
    if (currentPage === 'overview' && authToken) renderOverview();
  } catch (_) {
    // A server outage should not destroy the Live Wall itself.
  }
}

async function refreshControlData() {
  if (!authToken) return;
  try {
    const [roomsData, incidentsData] = await Promise.all([
      fetchJson('/api/rooms'),
      fetchJson('/api/incidents')
    ]);
    controlRooms = roomsData.rooms || [];
    incidents = incidentsData.incidents || [];
    wallStatuses = new Map(controlRooms.map((room) => [
      room.roomId,
      {
        roomId: room.roomId,
        roomName: room.roomName,
        health: room.health,
        issue: room.issue,
        changedAt: room.healthChangedAt || room.lastSeenIso
      }
    ]));
    renderRoomOptions();
    if (currentPage === 'wall') updateWallStatusDecorations();
    if (currentPage === 'overview') renderOverview();
    if (currentPage === 'rooms') renderRooms();
    if (currentPage === 'incidents') renderIncidents();
  } catch (err) {
    if (err.status === 401) signOut();
  }
}

function startPolling() {
  clearInterval(wallPollTimer);
  clearInterval(controlPollTimer);

  refreshWallStatuses();
  wallPollTimer = setInterval(refreshWallStatuses, 5000);

  if (authToken) {
    refreshControlData();
    controlPollTimer = setInterval(refreshControlData, 5000);
  }
}

function applyRoleUi() {
  const role = appConfig.role;

  document.body.classList.toggle('wall-mode', role === 'wall');
  document.body.classList.toggle('control-mode', role === 'control');

  if (role === 'wall') {
    els.techNav.classList.add('hidden');
    els.signInBtn.classList.add('hidden');
    els.profileBtn.classList.add('hidden');
    switchPage('wall');
    return;
  }

  if (role === 'control') {
    els.signInBtn.classList.toggle('hidden', Boolean(authToken));
    els.profileBtn.classList.toggle('hidden', !authToken);
    els.techNav.classList.toggle('hidden', !authToken);
    if (!authToken && currentPage !== 'wall') switchPage('wall');
  }
}

function switchPage(page) {
  if (!['overview', 'wall', 'rooms', 'incidents'].includes(page)) return;
  if (page !== 'wall' && !authToken) return;

  currentPage = page;
  fullscreenStreamId = null;
  document.body.classList.remove('focus-mode');

  for (const name of ['overview', 'wall', 'rooms', 'incidents']) {
    $(`${name}Page`).classList.toggle('hidden', name !== page);
  }

  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });

  renderCurrentPage();
}

function renderCurrentPage() {
  if (currentPage === 'wall') {
    renderFilters();
    renderWall();
    return;
  }

  els.wallGrid.innerHTML = '';

  if (currentPage === 'overview') renderOverview();
  if (currentPage === 'rooms') renderRooms();
  if (currentPage === 'incidents') renderIncidents();
}

function renderFilters() {
  const platforms = ['Fanatics', 'Whatnot', 'TikTok'].filter(
    (platform) => streams.some((stream) => platformFor(stream) === platform)
  );
  const filters = ['All', ...platforms, 'Critical'];

  if (!filters.includes(activeFilter)) activeFilter = 'All';

  els.platformFilters.innerHTML = filters.map((filter) => `
    <button class="filter-pill ${filter === activeFilter ? 'active' : ''}" data-filter="${escapeHtml(filter)}">
      ${escapeHtml(filter)}
    </button>
  `).join('');

  els.platformFilters.querySelectorAll('.filter-pill').forEach((button) => {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.filter;
      renderFilters();
      renderWall();
    });
  });
}

function streamMatchesFilter(stream) {
  if (activeFilter === 'All') return true;
  const status = statusForRoom(stream.roomId);
  if (activeFilter === 'Critical') {
    return status.health === 'critical' || status.health === 'offline';
  }
  return platformFor(stream) === activeFilter;
}

function createWallTile(stream) {
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
  refresh.title = 'Refresh stream';
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    tile.querySelector('webview')?.reload();
  });

  const focus = document.createElement('button');
  focus.className = 'micro-btn';
  focus.textContent = '⛶';
  focus.title = 'Enlarge stream';
  focus.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFullscreen(stream.id);
  });

  controls.append(refresh, focus);
  header.append(identity, controls);
  tile.append(header);

  const stage = document.createElement('div');
  stage.className = 'phone-stage';

  const view = createStreamWebview(stream);
  if (view) {
    const frame = document.createElement('div');
    frame.className = 'phone-frame';
    frame.append(view);
    stage.append(frame);
  } else {
    stage.innerHTML = '<div class="empty-stream">NO STREAM URL</div>';
  }

  tile.append(stage);

  if (['warning', 'critical', 'offline'].includes(status.health) && status.issue) {
    const issue = document.createElement('div');
    issue.className = `wall-issue ${status.health}`;
    issue.textContent = status.issue;
    tile.append(issue);
  }

  return tile;
}

function renderWall() {
  if (currentPage !== 'wall') return;
  els.wallGrid.innerHTML = '';
  const visibleStreams = streams.filter(streamMatchesFilter);
  visibleStreams.forEach((stream) => els.wallGrid.append(createWallTile(stream)));

  if (!visibleStreams.length) {
    els.wallGrid.innerHTML = '<div class="empty-state">No streams match this filter.</div>';
  }
}

function updateWallStatusDecorations() {
  if (currentPage !== 'wall') return;

  if (activeFilter === 'Critical') {
    renderWall();
    return;
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
}

function toggleFullscreen(streamId) {
  const tiles = [...els.wallGrid.querySelectorAll('.stream-tile')];

  if (fullscreenStreamId === streamId) {
    fullscreenStreamId = null;
    document.body.classList.remove('focus-mode');
    tiles.forEach((tile) => tile.classList.remove('fullscreen'));
    activeWebviews().forEach(resumeView);
    return;
  }

  fullscreenStreamId = streamId;
  document.body.classList.add('focus-mode');

  tiles.forEach((tile) => {
    const selected = tile.dataset.streamId === streamId;
    tile.classList.toggle('fullscreen', selected);
    const view = tile.querySelector('webview');
    if (selected) resumeView(view);
    else pauseView(view);
  });
}

function renderOverview() {
  const counts = {
    total: controlRooms.length,
    healthy: controlRooms.filter((room) => room.health === 'healthy').length,
    warning: controlRooms.filter((room) => room.health === 'warning').length,
    critical: controlRooms.filter((room) => ['critical', 'offline'].includes(room.health)).length
  };

  els.overviewSummary.innerHTML = `
    <div class="summary-card"><strong>${counts.total}</strong><span>Rooms</span></div>
    <div class="summary-card"><strong>${counts.healthy}</strong><span>Healthy</span></div>
    <div class="summary-card"><strong>${counts.warning}</strong><span>Warning</span></div>
    <div class="summary-card"><strong>${counts.critical}</strong><span>Critical</span></div>
  `;

  els.overviewRooms.innerHTML = controlRooms.map((room) => `
    <button class="overview-room health-${escapeHtml(room.health)}" data-room-id="${escapeHtml(room.roomId)}">
      <div>
        <span class="status-dot ${escapeHtml(room.health)}"></span>
        <strong>${escapeHtml(room.roomName)}</strong>
      </div>
      <span class="overview-room-status">${escapeHtml(room.issue || statusLabel(room.health))}</span>
    </button>
  `).join('') || '<div class="empty-state">No agents have reported yet.</div>';

  els.overviewRooms.querySelectorAll('.overview-room').forEach((button) => {
    button.addEventListener('click', () => {
      selectedRoomId = button.dataset.roomId;
      switchPage('rooms');
    });
  });
}

function renderRooms() {
  if (controlRooms.length && !controlRooms.some((room) => room.roomId === selectedRoomId)) {
    selectedRoomId = controlRooms[0].roomId;
  }

  els.roomsList.innerHTML = controlRooms.map((room) => `
    <button class="room-list-row ${room.roomId === selectedRoomId ? 'active' : ''}" data-room-id="${escapeHtml(room.roomId)}">
      <span>
        <span class="status-dot ${escapeHtml(room.health)}"></span>
        ${escapeHtml(room.roomName)}
      </span>
      <small>${escapeHtml(statusLabel(room.health))}</small>
    </button>
  `).join('') || '<div class="empty-state compact">No rooms connected.</div>';

  els.roomsList.querySelectorAll('.room-list-row').forEach((button) => {
    button.addEventListener('click', () => {
      selectedRoomId = button.dataset.roomId;
      renderRooms();
    });
  });

  renderRoomDetail();
}

function formatPercent(value) {
  return value === null || value === undefined ? '—' : `${Math.round(Number(value))}%`;
}

function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  let remaining = Math.max(0, Number(seconds));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h`;
}

function updateRoomDetailValues(room) {
  const metrics = room.metrics || {};
  const setMetric = (key, value) => {
    const node = els.roomDetail.querySelector(`[data-metric="${key}"]`);
    if (node) node.textContent = value;
  };
  const setInfo = (key, value) => {
    const node = els.roomDetail.querySelector(`[data-info="${key}"]`);
    if (node) node.textContent = value;
  };

  setMetric('cpu', formatPercent(metrics.cpuPercent));
  setMetric('ram', formatPercent(metrics.memoryPercent));
  setMetric('disk', formatPercent(metrics.diskFreePercent));
  setMetric('obs', metrics.obsRunning === true ? 'Running' : metrics.obsRunning === false ? 'Offline' : '—');
  setMetric('stream', metrics.streamingActive === true ? 'Live' : metrics.streamingActive === false ? 'Idle' : '—');
  setMetric('agent', room.health === 'offline' ? 'Offline' : 'Online');

  setInfo('ip', metrics.localIp || '—');
  setInfo('host', room.hostname || '—');
  setInfo('uptime', formatUptime(metrics.uptimeSeconds));
  setInfo('lastSeen', room.lastSeenIso ? new Date(room.lastSeenIso).toLocaleTimeString() : '—');

  const healthText = els.roomDetail.querySelector('.room-health-text');
  if (healthText) healthText.textContent = room.issue || statusLabel(room.health);

  const dot = els.roomDetail.querySelector('.room-detail-head .status-dot');
  if (dot) dot.className = `status-dot ${room.health}`;
}

function renderRoomDetail(force = false) {
  const room = controlRooms.find((candidate) => candidate.roomId === selectedRoomId);
  if (!room) {
    els.roomDetail.dataset.roomId = '';
    els.roomDetail.innerHTML = '<div class="empty-state">Select a room.</div>';
    return;
  }

  if (!force && els.roomDetail.dataset.roomId === room.roomId && els.roomDetail.querySelector('#roomVideoStage')) {
    updateRoomDetailValues(room);
    return;
  }

  const metrics = room.metrics || {};
  const matchingStream = streams.find((stream) => stream.roomId === room.roomId);
  els.roomDetail.dataset.roomId = room.roomId;

  els.roomDetail.innerHTML = `
    <div class="room-detail-head">
      <div>
        <div class="eyebrow">ROOM</div>
        <h1><span class="status-dot ${escapeHtml(room.health)}"></span>${escapeHtml(room.roomName)}</h1>
      </div>
      <div class="room-health-text">${escapeHtml(room.issue || statusLabel(room.health))}</div>
    </div>

    <div class="metrics-grid">
      <div class="metric-card"><span>CPU</span><strong data-metric="cpu">${formatPercent(metrics.cpuPercent)}</strong></div>
      <div class="metric-card"><span>RAM</span><strong data-metric="ram">${formatPercent(metrics.memoryPercent)}</strong></div>
      <div class="metric-card"><span>Disk Free</span><strong data-metric="disk">${formatPercent(metrics.diskFreePercent)}</strong></div>
      <div class="metric-card"><span>OBS</span><strong data-metric="obs">${metrics.obsRunning === true ? 'Running' : metrics.obsRunning === false ? 'Offline' : '—'}</strong></div>
      <div class="metric-card"><span>Stream</span><strong data-metric="stream">${metrics.streamingActive === true ? 'Live' : metrics.streamingActive === false ? 'Idle' : '—'}</strong></div>
      <div class="metric-card"><span>Agent</span><strong data-metric="agent">${room.health === 'offline' ? 'Offline' : 'Online'}</strong></div>
    </div>

    <div class="room-info-row">
      <span>IP <strong data-info="ip">${escapeHtml(metrics.localIp || '—')}</strong></span>
      <span>Host <strong data-info="host">${escapeHtml(room.hostname || '—')}</strong></span>
      <span>Uptime <strong data-info="uptime">${escapeHtml(formatUptime(metrics.uptimeSeconds))}</strong></span>
      <span>Last Seen <strong data-info="lastSeen">${escapeHtml(room.lastSeenIso ? new Date(room.lastSeenIso).toLocaleTimeString() : '—')}</strong></span>
    </div>

    <div class="room-video-wrap">
      <div class="section-label">${matchingStream ? escapeHtml(matchingStream.name) : 'LIVE VIDEO'}</div>
      <div id="roomVideoStage" class="room-video-stage"></div>
    </div>
  `;

  const stage = $('roomVideoStage');
  if (!matchingStream || !safeUrl(matchingStream.url)) {
    stage.innerHTML = '<div class="empty-state">No stream is linked to this room.</div>';
    return;
  }

  const frame = document.createElement('div');
  frame.className = 'room-phone-frame';
  const view = createStreamWebview(matchingStream);
  if (view) {
    frame.append(view);
    stage.append(frame);
  }
}

function renderIncidents() {
  els.incidentCount.textContent = `${incidents.length} events`;
  els.incidentsBody.innerHTML = incidents.map((incident) => `
    <tr>
      <td>${escapeHtml(formatDateTime(incident.openedAt))}</td>
      <td>${escapeHtml(incident.roomName || '—')}</td>
      <td>${escapeHtml(incident.message || '—')}</td>
      <td><span class="incident-badge ${escapeHtml(incident.status || 'info')}">${escapeHtml(incident.status || 'info')}</span></td>
      <td>${escapeHtml(incident.resolvedAt ? formatDateTime(incident.resolvedAt) : '—')}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty-cell">No incidents yet.</td></tr>';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function renderRoomOptions() {
  const roomMap = new Map();

  controlRooms.forEach((room) => roomMap.set(room.roomId, room.roomName));
  wallStatuses.forEach((room, roomId) => roomMap.set(roomId, room.roomName || roomId));

  els.roomOptions.innerHTML = [...roomMap.entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([roomId, roomName]) => `<option value="${escapeHtml(roomId)}">${escapeHtml(roomName)}</option>`)
    .join('');
}

let draftStreams = [];

function openStreamsManager() {
  draftStreams = streams.map((stream) => ({ ...stream }));
  renderStreamRows();
  els.streamsModal.classList.remove('hidden');
}

function closeStreamsManager() {
  els.streamsModal.classList.add('hidden');
}

function renderStreamRows() {
  els.streamRows.innerHTML = '';

  draftStreams.forEach((stream, index) => {
    const row = document.createElement('div');
    row.className = 'stream-editor-row';
    row.dataset.index = index;
    row.innerHTML = `
      <div class="stream-order">
        <button class="micro-btn move-up" title="Move up">↑</button>
        <button class="micro-btn move-down" title="Move down">↓</button>
      </div>
      <input class="stream-name-input" value="${escapeHtml(stream.name)}" placeholder="Stream name" />
      <input class="stream-url-input" value="${escapeHtml(stream.url)}" placeholder="https://..." />
      <select class="stream-platform-input">
        ${['Fanatics', 'Whatnot', 'TikTok', 'Other'].map((platform) =>
          `<option ${platform === platformFor(stream) ? 'selected' : ''}>${platform}</option>`
        ).join('')}
      </select>
      <input class="stream-room-input" list="roomOptions" value="${escapeHtml(stream.roomId || '')}" placeholder="Room" />
      <button class="micro-btn danger remove-stream" title="Remove stream">✕</button>
    `;

    row.querySelector('.move-up').addEventListener('click', () => moveDraft(index, -1));
    row.querySelector('.move-down').addEventListener('click', () => moveDraft(index, 1));
    row.querySelector('.remove-stream').addEventListener('click', () => {
      draftStreams = readDraftRows();
      if (draftStreams.length <= 1) return;
      draftStreams.splice(index, 1);
      renderStreamRows();
    });

    els.streamRows.append(row);
  });
}

function readDraftRows() {
  return [...els.streamRows.querySelectorAll('.stream-editor-row')].map((row, index) => ({
    id: draftStreams[index]?.id || `stream-${cryptoId()}`,
    name: row.querySelector('.stream-name-input').value.trim() || `Stream ${index + 1}`,
    url: row.querySelector('.stream-url-input').value.trim(),
    platform: row.querySelector('.stream-platform-input').value,
    roomId: row.querySelector('.stream-room-input').value.trim()
  }));
}

function cryptoId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function moveDraft(index, offset) {
  draftStreams = readDraftRows();
  const target = index + offset;
  if (target < 0 || target >= draftStreams.length) return;
  [draftStreams[index], draftStreams[target]] = [draftStreams[target], draftStreams[index]];
  renderStreamRows();
}

async function saveStreamsManager() {
  const next = readDraftRows();
  streams = await window.swish.saveStreams(next);
  closeStreamsManager();
  renderRoomOptions();
  els.roomDetail.dataset.roomId = '';
  renderCurrentPage();
}

function addDraftStream() {
  if (draftStreams.length >= 150) return;
  draftStreams = readDraftRows();
  draftStreams.push({
    id: `stream-${cryptoId()}`,
    name: `Stream ${draftStreams.length + 1}`,
    url: '',
    platform: 'Other',
    roomId: ''
  });
  renderStreamRows();
  els.streamRows.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

function openLogin() {
  els.loginError.classList.add('hidden');
  els.loginError.textContent = '';
  els.loginModal.classList.remove('hidden');
  setTimeout(() => els.loginEmail.focus(), 50);
}

function closeLogin() {
  els.loginModal.classList.add('hidden');
  els.loginPassword.value = '';
}

async function signIn() {
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;
  els.loginError.classList.add('hidden');

  try {
    const data = await fetchJson('/api/login', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ email, password })
    });
    authToken = data.token;
    authUser = data.user;
    els.profileBtn.textContent = (authUser?.name || authUser?.email || 'U').trim().charAt(0).toUpperCase();
    els.profileBtn.title = `${authUser?.name || authUser?.email || 'Control user'} — click to sign out`;
    closeLogin();
    applyRoleUi();
    startPolling();
    await refreshControlData();
    switchPage('overview');
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.classList.remove('hidden');
  }
}

function signOut() {
  authToken = '';
  authUser = null;
  controlRooms = [];
  incidents = [];
  selectedRoomId = '';
  clearInterval(controlPollTimer);
  controlPollTimer = null;
  applyRoleUi();
  switchPage('wall');
}

function showSetup() {
  els.setupModal.classList.remove('hidden');
  pendingRole = '';
  els.setupFields.classList.add('hidden');
  document.querySelectorAll('.role-card').forEach((card) => card.classList.remove('selected'));
}

function chooseSetupRole(role) {
  pendingRole = role;
  document.querySelectorAll('.role-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.role === role);
  });

  els.setupFields.classList.remove('hidden');
  els.setupRoomWrap.classList.toggle('hidden', role !== 'agent');
  els.setupKeyWrap.classList.toggle('hidden', role !== 'agent');
  els.setupObsPasswordWrap.classList.toggle('hidden', role !== 'agent');
}

async function saveSetup() {
  if (!pendingRole) return;

  const serverUrl = normalizeServerUrl(els.setupServerUrl.value);
  const patch = { role: pendingRole, serverUrl };

  if (pendingRole === 'control' && !serverUrl) {
    els.setupServerUrl.focus();
    return;
  }

  if (pendingRole === 'agent') {
    const roomName = els.setupRoomName.value.trim();
    const enrollmentKey = els.setupEnrollmentKey.value;
    if (!serverUrl || !roomName || !enrollmentKey) return;

    patch.roomName = roomName;
    patch.agentEnrollmentKey = enrollmentKey;
    patch.obsWebSocketPassword = els.setupObsPassword.value;
  }

  appConfig = await window.swish.saveAppConfig(patch);

  if (pendingRole === 'agent') {
    await window.swish.restartApp();
    return;
  }

  els.setupModal.classList.add('hidden');
  applyRoleUi();
  startPolling();
  switchPage('wall');
}

function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => switchPage(button.dataset.page));
  });

  els.signInBtn.addEventListener('click', openLogin);
  els.profileBtn.addEventListener('click', signOut);
  els.loginCancelBtn.addEventListener('click', closeLogin);
  els.loginSubmitBtn.addEventListener('click', signIn);
  els.loginPassword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') signIn();
  });

  els.refreshAllBtn.addEventListener('click', () => {
    activeWebviews().forEach((view) => view.reload());
  });

  els.manageStreamsBtn.addEventListener('click', openStreamsManager);
  els.streamsCloseBtn.addEventListener('click', closeStreamsManager);
  els.streamsCancelBtn.addEventListener('click', closeStreamsManager);
  els.streamsSaveBtn.addEventListener('click', saveStreamsManager);
  els.addStreamBtn.addEventListener('click', addDraftStream);

  document.querySelectorAll('.role-card').forEach((card) => {
    card.addEventListener('click', () => chooseSetupRole(card.dataset.role));
  });

  els.setupBackBtn.addEventListener('click', showSetup);
  els.setupSaveBtn.addEventListener('click', saveSetup);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && fullscreenStreamId) {
      toggleFullscreen(fullscreenStreamId);
      return;
    }
    if (event.key === 'Escape' && !els.streamsModal.classList.contains('hidden')) {
      closeStreamsManager();
      return;
    }
    if (event.key === 'Escape' && !els.loginModal.classList.contains('hidden')) {
      closeLogin();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) activeWebviews().forEach(pauseView);
    else activeWebviews().forEach(resumeView);
  });
}

async function bootstrap() {
  bindEvents();
  [streams, appConfig] = await Promise.all([
    window.swish.getStreams(),
    window.swish.getAppConfig()
  ]);

  renderRoomOptions();

  if (!appConfig.role) {
    showSetup();
  } else {
    applyRoleUi();
  }

  renderFilters();
  renderWall();
  startPolling();
}

bootstrap().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="fatal-error">Swish Control failed to start.<br>${escapeHtml(err.message)}</div>`;
});
