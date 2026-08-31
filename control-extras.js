// Monitoring/admin controls layered on top of the stable Swish Control UI.

// TikTok behaves poorly when Electron on Windows presents the iPhone Safari
// user agent that is proven on macOS. Keep the Mac behavior unchanged, but
// present TikTok with a normal Windows Chrome identity on Windows builds.
const WINDOWS_TIKTOK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const baseUserAgentForPlatform = userAgentFor;
userAgentFor = function userAgentForPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const isTikTok = host === 'tiktok.com' || host.endsWith('.tiktok.com');
    const isWindows = /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
    if (isTikTok && isWindows) return WINDOWS_TIKTOK_UA;
  } catch (_) {}
  return baseUserAgentForPlatform(url);
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

setInterval(() => {
  if (appConfig.serverUrl) pingControlServer();
}, 30000);
