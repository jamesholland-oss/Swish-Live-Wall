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
        <strong><span class="production-dot"></span>${escapeHtml(state.label)}</strong>
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

const baseRenderRoomDetail = renderRoomDetail;
renderRoomDetail = function renderRoomDetailWithAdmin(force = false) {
  baseRenderRoomDetail(force);

  const room = controlRooms.find((candidate) => candidate.roomId === selectedRoomId);
  if (!room || !authToken) return;

  renderProductionHealth(room);

  if (els.roomDetail.querySelector('.room-admin-bar')) return;

  const bar = document.createElement('div');
  bar.className = 'room-admin-bar';

  const remove = document.createElement('button');
  remove.className = 'danger-action';
  remove.textContent = 'Remove from Monitoring';
  remove.addEventListener('click', () => removeRoomFromMonitoring(room));

  bar.append(remove);

  const productionSection = els.roomDetail.querySelector('.production-health');
  const videoWrap = els.roomDetail.querySelector('.room-video-wrap');
  if (productionSection) els.roomDetail.insertBefore(bar, productionSection);
  else if (videoWrap) els.roomDetail.insertBefore(bar, videoWrap);
  else els.roomDetail.append(bar);
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
