// Monitoring/admin controls layered on top of the stable Swish Control UI.
// Provider-specific presentation belongs in the dedicated compatibility files;
// do not override TikTok user agents here.

const CONTROL_SESSION_KEY = 'swish-control-session-v1';

function readSavedControlSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONTROL_SESSION_KEY) || 'null');
    if (!saved?.token || !saved?.user) return null;
    return saved;
  } catch (_) {
    return null;
  }
}

function saveControlSession(token, user) {
  try {
    if (!token || !user) return;
    localStorage.setItem(CONTROL_SESSION_KEY, JSON.stringify({ token, user }));
  } catch (_) {}
}

function clearControlSession() {
  try { localStorage.removeItem(CONTROL_SESSION_KEY); } catch (_) {}
}

// Restore the most recent server session before bootstrap resumes from its IPC
// reads. The server remains authoritative and a 401 still signs the user out.
const savedControlSession = readSavedControlSession();
if (savedControlSession) {
  authToken = savedControlSession.token;
  authUser = savedControlSession.user;
}

const baseFetchJsonForSession = fetchJson;
fetchJson = async function fetchJsonWithSessionPersistence(pathname, options = {}, timeoutMs = 5000) {
  try {
    const data = await baseFetchJsonForSession(pathname, options, timeoutMs);
    if (pathname === '/api/login' && data?.token && data?.user) {
      saveControlSession(data.token, data.user);
    }
    return data;
  } catch (err) {
    if (err?.status === 401 && pathname !== '/api/login') clearControlSession();
    throw err;
  }
};

const serverStateEl = document.getElementById('serverState');
const serverStateTextEl = document.getElementById('serverStateText');

function setServerState(mode, label) {
  if (!serverStateEl || !serverStateTextEl) return;
  serverStateEl.classList.remove('hidden', 'connected', 'error');
  if (mode) serverStateEl.classList.add(mode);
  serverStateTextEl.textContent = label;
}

function hideServerState() {
  serverStateEl?.classList.add('hidden');
}

async function pingControlServer() {
  if (!appConfig.serverUrl) {
    hideServerState();
    return false;
  }

  try {
    const result = await fetchJson('/health', { auth: false }, 3500);
    setServerState('connected', `${result.rooms ?? 0} rooms`);
    return true;
  } catch (_) {
    setServerState('error', 'Server offline');
    return false;
  }
}

async function removeRoomFromMonitoring(room) {
  if (!room?.agentId) return;

  const ok = window.confirm(
    `Remove ${room.roomName} from monitoring?\n\nThis revokes this device's monitoring credential and removes it from active rooms. Incident history will be kept.`
  );
  if (!ok) return;

  try {
    await fetchJson(`/api/agents/${encodeURIComponent(room.agentId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Removed from Swish Control' })
    });

    controlRooms = controlRooms.filter((candidate) => candidate.agentId !== room.agentId);
    wallStatuses.delete(room.roomId);
    selectedRoomId = controlRooms[0]?.roomId || '';
    renderRoomOptions();
    renderRooms();
    renderOverview();
    updateWallStatusDecorations();
    await refreshControlData();
  } catch (err) {
    window.alert(`Could not remove device: ${err.message}`);
  }
}

function productionState(ok, unknown = false) {
  if (unknown) return { className: 'unknown', label: 'Unknown' };
  return ok ? { className: 'ok', label: 'Running' } : { className: 'bad', label: 'Offline' };
}

function productionCard(title, state, details = []) {
  return `
    <div class="production-card ${state.className}">
      <div class="production-card-head">
        <span>${escapeHtml(title)}</span>
        <span class="production-status-dot" title="${escapeHtml(state.label)}" aria-label="${escapeHtml(state.label)}">
          <span class="production-dot"></span>
        </span>
      </div>
      ${details.filter(Boolean).map((detail) => `<div class="production-detail">${detail}</div>`).join('')}
    </div>
  `;
}

function renderProductionHealth(room) {
  const metrics = room.metrics || {};
  const apps = metrics.productionApps;
  let section = els.roomDetail.querySelector('.production-health');

  if (!apps) {
    if (section) section.remove();
    return;
  }

  const obsState = productionState(Boolean(apps.obs?.running));
  const shadeState = productionState(Boolean(apps.shade?.running));
  const shadeMount = apps.shade?.mounted === null || apps.shade?.mounted === undefined
    ? { className: 'unknown', label: 'Unknown' }
    : apps.shade.mounted
      ? { className: 'ok', label: 'Mounted' }
      : { className: 'bad', label: 'Unmounted' };
  const cameraState = productionState(Boolean(apps.cameraControl?.running));
  const streamDeckState = productionState(Boolean(apps.streamDeck?.running));

  const obsDetails = [
    `WebSocket: <strong>${metrics.obsWebSocketAuthenticated ? 'Connected' : metrics.obsWebSocketReachable ? 'Needs authentication' : 'Unavailable'}</strong>`,
    `Stream: <strong>${metrics.streamingActive === true ? 'Live' : metrics.streamingActive === false ? 'Idle' : '—'}</strong>`,
    apps.obs?.version ? `Version: <strong>${escapeHtml(apps.obs.version)}</strong>` : ''
  ];

  const shadeDetails = [
    `Storage: <strong class="production-inline ${shadeMount.className}">${escapeHtml(shadeMount.label)}</strong>`,
    apps.shade?.mountPath ? `Path: <strong>${escapeHtml(apps.shade.mountPath)}</strong>` : '',
    apps.shade?.version ? `Version: <strong>${escapeHtml(apps.shade.version)}</strong>` : ''
  ];

  const cameraDetails = [
    apps.cameraControl?.app ? `Controller: <strong>${escapeHtml(apps.cameraControl.app)}</strong>` : 'Controller: <strong>Not detected</strong>',
    apps.cameraControl?.version ? `Version: <strong>${escapeHtml(apps.cameraControl.version)}</strong>` : ''
  ];

  const streamDeckDetails = [
    apps.streamDeck?.version ? `Version: <strong>${escapeHtml(apps.streamDeck.version)}</strong>` : ''
  ];

  const checkedAt = apps.checkedAt ? new Date(apps.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
  const html = `
    <div class="production-health-head">
      <span>PRODUCTION HEALTH</span>
      <small>Checked ${escapeHtml(checkedAt)}</small>
    </div>
    <div class="production-grid">
      ${productionCard('OBS', obsState, obsDetails)}
      ${productionCard('SHADE', shadeState, shadeDetails)}
      ${productionCard('CAMERA CONTROL', cameraState, cameraDetails)}
      ${productionCard('STREAM DECK', streamDeckState, streamDeckDetails)}
    </div>
  `;

  if (!section) {
    section = document.createElement('section');
    section.className = 'production-health';
    const videoWrap = els.roomDetail.querySelector('.room-video-wrap');
    if (videoWrap) els.roomDetail.insertBefore(section, videoWrap);
    else els.roomDetail.append(section);
  }
  section.innerHTML = html;
}

function formatBusinessNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function formatBusinessMoney(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—';
}

function renderBusinessPanel(room) {
  let section = els.roomDetail.querySelector('.business-panel');
  if (!userCan('sales:view')) {
    section?.remove();
    return;
  }

  const business = room.business || null;
  if (!section) {
    section = document.createElement('section');
    section.className = 'business-panel';
  }

  section.innerHTML = `
    <div class="room-panel-head">
      <span>LIVE BUSINESS</span>
      <small>${business?.updatedAt ? `Updated ${escapeHtml(new Date(business.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : 'Waiting for data'}</small>
    </div>
    <div class="business-grid">
      <div class="business-stat"><span>Viewers</span><strong>${formatBusinessNumber(business?.viewers)}</strong></div>
      <div class="business-stat"><span>Peak</span><strong>${formatBusinessNumber(business?.peakViewers)}</strong></div>
      <div class="business-stat"><span>Sales</span><strong>${formatBusinessMoney(business?.revenue)}</strong></div>
      <div class="business-stat"><span>Orders</span><strong>${formatBusinessNumber(business?.orders)}</strong></div>
      <div class="business-stat"><span>AOV</span><strong>${formatBusinessMoney(business?.aov)}</strong></div>
      <div class="business-stat"><span>Platform</span><strong>${escapeHtml(business?.platform || '—')}</strong></div>
    </div>
    <div class="business-break">
      <span>Current Break</span>
      <strong>${escapeHtml(business?.currentBreak || '—')}</strong>
    </div>
  `;

  if (!section.isConnected) els.roomDetail.append(section);
}

function renderRecentMedia(room) {
  let section = els.roomDetail.querySelector('.recent-media');
  if (!userCan('clips:view')) {
    section?.remove();
    return;
  }

  const clips = Array.isArray(room.clips)
    ? room.clips.filter((item) => item.kind === 'clip').slice(0, 8)
    : [];

  if (!section) {
    section = document.createElement('section');
    section.className = 'recent-media';
  }

  section.innerHTML = `
    <div class="room-panel-head">
      <span>RECENT CLIPS</span>
      <small>${clips.length ? `${clips.length} shown` : 'No clips reported yet'}</small>
    </div>
    <div class="recent-media-list">
      ${clips.length ? clips.map((clip) => `
        <div class="recent-media-row">
          <div>
            <strong>${escapeHtml(clip.fileName || 'Replay')}</strong>
            <span>${escapeHtml(formatDateTime(clip.createdAt))}</span>
          </div>
          <div class="media-status ${clip.shadeVerified ? 'ok' : 'warn'}">
            ${clip.shadeVerified ? 'SHADE ✓' : clip.shadeAttempted ? 'SHADE ⚠' : 'LOCAL'}
          </div>
        </div>
      `).join('') : '<div class="recent-media-empty">Replay clips from this room will appear here automatically.</div>'}
    </div>
  `;

  if (!section.isConnected) els.roomDetail.append(section);
}

function setRoomFocusMode(enabled) {
  document.body.classList.toggle('room-focus-mode', Boolean(enabled));
  const button = els.roomDetail?.querySelector('.room-focus-toggle');
  if (button) button.textContent = enabled ? '← EXIT FULL VIEW' : '⛶ FULL VIEW';
}

function ensureRoomFocusButton() {
  const head = els.roomDetail.querySelector('.room-detail-head');
  if (!head) return;
  let button = head.querySelector('.room-focus-toggle');
  if (button) return;

  button = document.createElement('button');
  button.className = 'ghost room-focus-toggle';
  button.textContent = document.body.classList.contains('room-focus-mode') ? '← EXIT FULL VIEW' : '⛶ FULL VIEW';
  button.addEventListener('click', () => setRoomFocusMode(!document.body.classList.contains('room-focus-mode')));
  head.append(button);
}

function arrangeRoomDetailLayout(room) {
  const videoWrap = els.roomDetail.querySelector('.room-video-wrap');
  if (!videoWrap) return;

  let layout = els.roomDetail.querySelector('.room-live-layout');
  if (!layout) {
    layout = document.createElement('div');
    layout.className = 'room-live-layout';
    layout.innerHTML = '<div class="room-live-primary"></div><aside class="room-live-side"></aside>';
    videoWrap.parentNode.insertBefore(layout, videoWrap);
  }

  const primary = layout.querySelector('.room-live-primary');
  const side = layout.querySelector('.room-live-side');
  if (videoWrap.parentNode !== primary) primary.append(videoWrap);

  const business = els.roomDetail.querySelector('.business-panel');
  const metrics = els.roomDetail.querySelector('.metrics-grid');
  const production = els.roomDetail.querySelector('.production-health');
  const info = els.roomDetail.querySelector('.room-info-row');

  [business, metrics, production, info].filter(Boolean).forEach((node) => side.append(node));

  const recent = els.roomDetail.querySelector('.recent-media');
  if (recent && recent.previousElementSibling !== layout) layout.insertAdjacentElement('afterend', recent);

  const matchingStream = streams.find((stream) => stream.roomId === room.roomId);
  const frame = els.roomDetail.querySelector('.room-phone-frame');
  if (frame && matchingStream) frame.dataset.platform = platformFor(matchingStream);
}

const baseRenderRoomDetail = renderRoomDetail;
renderRoomDetail = function renderRoomDetailWithAdmin(force = false) {
  baseRenderRoomDetail(force);

  const room = controlRooms.find((candidate) => candidate.roomId === selectedRoomId);
  if (!room || !authToken) return;

  renderProductionHealth(room);
  renderBusinessPanel(room);
  renderRecentMedia(room);

  let bar = els.roomDetail.querySelector('.room-admin-bar');
  if (userCan('settings:manage')) {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'room-admin-bar';

      const remove = document.createElement('button');
      remove.className = 'danger-action';
      remove.textContent = 'Remove from Monitoring';
      remove.addEventListener('click', () => removeRoomFromMonitoring(room));
      bar.append(remove);

      const layout = els.roomDetail.querySelector('.room-live-layout');
      const videoWrap = els.roomDetail.querySelector('.room-video-wrap');
      if (layout) els.roomDetail.insertBefore(bar, layout);
      else if (videoWrap) els.roomDetail.insertBefore(bar, videoWrap);
      else els.roomDetail.append(bar);
    }
  } else {
    bar?.remove();
  }

  arrangeRoomDetailLayout(room);
  ensureRoomFocusButton();
};

function renderAgentShell() {
  let shell = document.getElementById('agentShell');
  if (!shell) {
    shell = document.createElement('section');
    shell.id = 'agentShell';
    shell.className = 'agent-shell';
    document.body.append(shell);
  }

  shell.innerHTML = `
    <div class="agent-card">
      <div class="agent-kicker">SWISH CONTROL AGENT</div>
      <h1>${escapeHtml(appConfig.roomName || 'Room Agent')}</h1>
      <div class="agent-status-row"><span class="agent-live-dot"></span><strong>Monitoring active</strong></div>
      <div class="agent-meta">${escapeHtml(appConfig.serverUrl || 'Server not configured')}</div>
      <div class="agent-actions">
        <button id="agentHideBtn" class="ghost">Hide Window</button>
        <button id="agentChangeModeBtn" class="primary">Change Mode</button>
      </div>
      <div class="agent-note">Hiding this window does not stop monitoring.</div>
    </div>
  `;

  document.body.classList.add('agent-ui-mode');
  document.getElementById('agentHideBtn')?.addEventListener('click', () => window.close());
  document.getElementById('agentChangeModeBtn')?.addEventListener('click', async () => {
    await window.swish.saveAppConfig({ role: '' });
    await window.swish.restartApp();
  });
}

function clearAgentShell() {
  document.body.classList.remove('agent-ui-mode');
  document.getElementById('agentShell')?.remove();
}

const baseApplyRoleUi = applyRoleUi;
applyRoleUi = function applyRoleUiWithAgentShell() {
  baseApplyRoleUi();
  if (appConfig.role === 'agent') renderAgentShell();
  else clearAgentShell();
};

const baseRefreshControlData = refreshControlData;
refreshControlData = async function refreshControlDataWithServerState() {
  try {
    await baseRefreshControlData();
    if (appConfig.serverUrl) setServerState('connected', `${controlRooms.length} rooms`);
  } catch (err) {
    if (appConfig.serverUrl) setServerState('error', 'Server offline');
    throw err;
  }
};

const baseStartPolling = startPolling;
startPolling = function startPollingWithServerHealth() {
  baseStartPolling();
  pingControlServer();
};

// The original click listener is already bound by renderer.js, so use a small
// secondary listener only to clear the persisted copy when the user signs out.
els.profileBtn?.addEventListener('click', () => clearControlSession());

setInterval(() => {
  if (appConfig.serverUrl) pingControlServer();
}, 30000);


window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('room-focus-mode')) {
    setRoomFocusMode(false);
  }
});
