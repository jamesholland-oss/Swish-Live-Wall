// Monitoring/admin controls layered on top of the stable Swish Control UI.

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

const baseRenderRoomDetail = renderRoomDetail;
renderRoomDetail = function renderRoomDetailWithAdmin(force = false) {
  baseRenderRoomDetail(force);

  const room = controlRooms.find((candidate) => candidate.roomId === selectedRoomId);
  if (!room || !authToken) return;
  if (els.roomDetail.querySelector('.room-admin-bar')) return;

  const bar = document.createElement('div');
  bar.className = 'room-admin-bar';

  const remove = document.createElement('button');
  remove.className = 'danger-action';
  remove.textContent = 'Remove from Monitoring';
  remove.addEventListener('click', () => removeRoomFromMonitoring(room));

  bar.append(remove);

  const videoWrap = els.roomDetail.querySelector('.room-video-wrap');
  if (videoWrap) els.roomDetail.insertBefore(bar, videoWrap);
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
