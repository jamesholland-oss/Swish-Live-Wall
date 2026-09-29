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

let accessPageEl = null;
let accessRootEl = null;
let accessNavBtn = null;

function ensureAccessUi() {
  if (!accessPageEl) {
    accessPageEl = document.getElementById('accessPage');
    if (!accessPageEl) {
      accessPageEl = document.createElement('section');
      accessPageEl.id = 'accessPage';
      accessPageEl.className = 'page hidden';
      accessRootEl = document.createElement('div');
      accessRootEl.id = 'accessRoot';
      accessRootEl.className = 'access-root';
      accessPageEl.append(accessRootEl);
      document.getElementById('appRoot')?.append(accessPageEl);
    } else {
      accessRootEl = accessPageEl.querySelector('#accessRoot');
    }
  }

  if (!accessNavBtn) {
    accessNavBtn = document.querySelector('.nav-btn[data-page="access"]');
    if (!accessNavBtn && els.techNav) {
      accessNavBtn = document.createElement('button');
      accessNavBtn.className = 'nav-btn';
      accessNavBtn.dataset.page = 'access';
      accessNavBtn.textContent = 'Users & Access';
      els.techNav.append(accessNavBtn);
      accessNavBtn.addEventListener('click', () => switchPage('access'));
    }
  }

  if (accessNavBtn) {
    accessNavBtn.classList.toggle('hidden', !authToken || !userCan('users:manage'));
  }
}

async function renderAccessUsers() {
  ensureAccessUi();
  if (!accessRootEl || !userCan('users:manage')) return;

  accessRootEl.innerHTML = '<div class="access-loading">Loading access…</div>';

  try {
    const data = await fetchJson('/api/access/users');
    const roles = Array.isArray(data.roles) ? data.roles : [];
    const users = Array.isArray(data.users) ? data.users : [];
    const roleOptions = roles.map((role) =>
      `<option value="${escapeHtml(role)}">${escapeHtml(role.replaceAll('_', ' '))}</option>`
    ).join('');

    accessRootEl.innerHTML = `
      <div class="access-head">
        <div>
          <div class="eyebrow">WORKSPACE ACCESS</div>
          <h1>Users & Access</h1>
          <p>Anyone in <strong>${escapeHtml(data.workspaceDomain || 'your Workspace')}</strong> can sign in with the company Google account. New users start as <strong>${escapeHtml(data.defaultRole || 'viewer')}</strong>.</p>
        </div>
      </div>

      <section class="access-add-card">
        <div class="room-panel-head">
          <span>ASSIGN ACCESS BEFORE FIRST LOGIN</span>
          <small>Optional — employees also appear here automatically after first sign-in.</small>
        </div>
        <div class="access-add-grid">
          <input id="accessEmailInput" type="email" placeholder="employee@${escapeHtml(data.workspaceDomain || 'company.com')}" />
          <input id="accessNameInput" type="text" placeholder="Name" />
          <select id="accessRoleInput">${roleOptions}</select>
          <button id="accessAddBtn" class="primary">Add User</button>
        </div>
        <div id="accessError" class="form-error hidden"></div>
      </section>

      <section class="access-table-card">
        <div class="room-panel-head">
          <span>COMPANY ACCESS</span>
          <small>${users.length} account${users.length === 1 ? '' : 's'}</small>
        </div>
        <div class="table-wrap">
          <table class="access-table">
            <thead>
              <tr><th>User</th><th>Role</th><th>Status</th><th>Last Login</th><th>Source</th><th></th></tr>
            </thead>
            <tbody>
              ${users.length ? users.map((user) => `
                <tr data-access-email="${escapeHtml(user.email)}">
                  <td>
                    <strong>${escapeHtml(user.name || user.email)}</strong>
                    <span>${escapeHtml(user.email)}</span>
                  </td>
                  <td>
                    <select class="access-role-select" ${user.source === 'environment' ? 'disabled' : ''}>
                      ${roles.map((role) => `<option value="${escapeHtml(role)}" ${role === user.role ? 'selected' : ''}>${escapeHtml(role.replaceAll('_', ' '))}</option>`).join('')}
                    </select>
                  </td>
                  <td><span class="access-status ${user.enabled === false ? 'disabled' : 'active'}">${user.enabled === false ? 'DISABLED' : 'ACTIVE'}</span></td>
                  <td>${escapeHtml(user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never')}</td>
                  <td>${escapeHtml(user.source === 'environment' ? 'Railway fallback' : 'Workspace')}</td>
                  <td>
                    ${user.source === 'environment'
                      ? '<span class="access-fixed">FIXED</span>'
                      : `<button class="ghost access-save-btn">Save</button>
                         <button class="ghost access-toggle-btn">${user.enabled === false ? 'Enable' : 'Disable'}</button>`}
                  </td>
                </tr>
              `).join('') : '<tr><td colspan="6" class="empty-cell">No Workspace employees have signed in yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    `;

    const errorEl = accessRootEl.querySelector('#accessError');
    const showError = (message) => {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    };

    accessRootEl.querySelector('#accessAddBtn')?.addEventListener('click', async () => {
      const email = accessRootEl.querySelector('#accessEmailInput')?.value.trim();
      const name = accessRootEl.querySelector('#accessNameInput')?.value.trim();
      const role = accessRootEl.querySelector('#accessRoleInput')?.value;
      if (!email) return showError('Enter a company email address.');
      try {
        await fetchJson('/api/access/users', {
          method: 'POST',
          body: JSON.stringify({ email, name, role, enabled: true })
        });
        await renderAccessUsers();
      } catch (err) {
        showError(err.message);
      }
    });

    accessRootEl.querySelectorAll('tr[data-access-email]').forEach((row) => {
      const email = row.dataset.accessEmail;
      const roleSelect = row.querySelector('.access-role-select');

      row.querySelector('.access-save-btn')?.addEventListener('click', async () => {
        try {
          await fetchJson('/api/access/users', {
            method: 'POST',
            body: JSON.stringify({
              email,
              name: row.querySelector('td strong')?.textContent || email,
              role: roleSelect?.value,
              enabled: true
            })
          });
          await renderAccessUsers();
        } catch (err) {
          showError(err.message);
        }
      });

      row.querySelector('.access-toggle-btn')?.addEventListener('click', async (event) => {
        try {
          const disabling = event.currentTarget.textContent.trim() === 'Disable';
          if (disabling) {
            await fetchJson(`/api/access/users/${encodeURIComponent(email)}`, {
              method: 'DELETE'
            });
          } else {
            await fetchJson('/api/access/users', {
              method: 'POST',
              body: JSON.stringify({
                email,
                name: row.querySelector('td strong')?.textContent || email,
                role: roleSelect?.value || 'viewer',
                enabled: true
              })
            });
          }
          await renderAccessUsers();
        } catch (err) {
          showError(err.message);
        }
      });
    });
  } catch (err) {
    accessRootEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
}

const baseSwitchPageForAccess = switchPage;
switchPage = function switchPageWithAccess(page) {
  if (page !== 'access') return baseSwitchPageForAccess(page);
  if (!authToken || !userCan('users:manage')) return;

  ensureAccessUi();
  currentPage = 'access';
  fullscreenStreamId = null;
  document.body.classList.remove('focus-mode', 'room-focus-mode');

  for (const name of ['overview', 'wall', 'rooms', 'reports', 'incidents']) {
    document.getElementById(`${name}Page`)?.classList.add('hidden');
  }
  accessPageEl?.classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === 'access');
  });

  if (els.wallGrid) els.wallGrid.innerHTML = '';
  restorePortaledWallStream?.();
  wallViews?.().forEach(pauseView);
  renderAccessUsers();
};

const baseApplyRoleUiForAccess = applyRoleUi;
applyRoleUi = function applyRoleUiWithAccess() {
  baseApplyRoleUiForAccess();
  ensureAccessUi();

  if (currentPage === 'access' && (!authToken || !userCan('users:manage'))) {
    baseSwitchPageForAccess('wall');
  }
};

ensureAccessUi();

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

async function renameRoomDisplay(room) {
  if (!room?.roomId) return;

  const nextName = window.prompt('Room display name', room.roomName || '');
  if (nextName == null) return;

  const displayName = String(nextName || '').trim();
  if (!displayName) {
    window.alert('Room name cannot be blank.');
    return;
  }

  try {
    await fetchJson(`/api/rooms/${encodeURIComponent(room.roomId)}/settings`, {
      method: 'POST',
      body: JSON.stringify({ displayName })
    });

    await refreshWallStatuses();
    await refreshControlData();
    selectedRoomId = room.roomId;
    renderRooms(true);
  } catch (err) {
    window.alert(`Unable to rename room: ${err.message}`);
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

function reportMoney(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '—';
}

function reportNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '—';
}

function reportAov(revenue, orders) {
  const r = Number(revenue);
  const o = Number(orders);
  if (!Number.isFinite(r) || !Number.isFinite(o) || o <= 0) return '—';
  return (r / o).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderReports() {
  if (!els.reportsRoot || !userCan('sales:reports')) return;

  const rows = controlRooms
    .filter((room) => room.business && typeof room.business === 'object')
    .map((room) => ({
      room,
      business: room.business,
      revenue: Number(room.business.revenue) || 0,
      orders: Number(room.business.orders) || 0,
      viewers: Number(room.business.viewers) || 0,
      peakViewers: Number(room.business.peakViewers) || 0
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalOrders = rows.reduce((sum, row) => sum + row.orders, 0);
  const totalViewers = rows.reduce((sum, row) => sum + row.viewers, 0);
  const activeStreams = rows.filter((row) => row.business.live === true).length;
  const latestUpdateMs = rows.reduce((latest, row) => {
    const value = Date.parse(row.business.updatedAt || '');
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, 0);

  const freshness = latestUpdateMs
    ? `Updated ${new Date(latestUpdateMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
    : 'Waiting for business data';

  els.reportsRoot.innerHTML = `
    <div class="reports-head">
      <div>
        <div class="eyebrow">LIVE BUSINESS</div>
        <h1>Reports</h1>
      </div>
      <div class="reports-freshness">${escapeHtml(freshness)}</div>
    </div>

    <div class="reports-summary">
      <div class="report-summary-card"><span>GMV</span><strong>${reportMoney(totalRevenue)}</strong></div>
      <div class="report-summary-card"><span>Orders</span><strong>${reportNumber(totalOrders)}</strong></div>
      <div class="report-summary-card"><span>AOV</span><strong>${reportAov(totalRevenue, totalOrders)}</strong></div>
      <div class="report-summary-card"><span>Live Viewers</span><strong>${reportNumber(totalViewers)}</strong></div>
      <div class="report-summary-card"><span>Active Streams</span><strong>${reportNumber(activeStreams)}</strong></div>
    </div>

    <section class="reports-table-card">
      <div class="room-panel-head">
        <span>CHANNEL PERFORMANCE</span>
        <small>Current 6AM–6AM reporting window from SB Live data</small>
      </div>

      <div class="table-wrap">
        <table class="reports-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Platform</th>
              <th>Status</th>
              <th>Viewers</th>
              <th>Peak</th>
              <th>GMV</th>
              <th>Orders</th>
              <th>AOV</th>
              <th>Current Break</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(({ room, business, revenue, orders, viewers, peakViewers }) => `
              <tr data-report-room="${escapeHtml(room.roomId)}">
                <td><button class="report-room-link" data-room-id="${escapeHtml(room.roomId)}">${escapeHtml(room.roomName)}</button></td>
                <td>${escapeHtml(business.platform || '—')}</td>
                <td><span class="report-live-pill ${business.live === true ? 'live' : 'off'}">${business.live === true ? 'LIVE' : 'OFF'}</span></td>
                <td>${reportNumber(viewers)}</td>
                <td>${reportNumber(peakViewers)}</td>
                <td>${reportMoney(revenue)}</td>
                <td>${reportNumber(orders)}</td>
                <td>${reportAov(revenue, orders)}</td>
                <td class="report-break-cell">${escapeHtml(business.currentBreak || '—')}</td>
              </tr>
            `).join('') : `
              <tr><td colspan="9" class="empty-cell">No business data has arrived yet. Start the SB Live → Swish Control bridge to populate live numbers.</td></tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;

  els.reportsRoot.querySelectorAll('.report-room-link').forEach((button) => {
    button.addEventListener('click', () => {
      selectedRoomId = button.dataset.roomId;
      switchPage('rooms');
    });
  });
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
          <div class="recent-media-main">
            <strong>${escapeHtml(clip.hit?.description || clip.fileName || 'Replay')}</strong>
            <span>
              ${escapeHtml(formatDateTime(clip.createdAt))}
              ${clip.hit?.type ? ` • ${escapeHtml(String(clip.hit.type).toUpperCase())} HIT` : ''}
              ${clip.hit?.teams ? ` • ${escapeHtml(clip.hit.teams)}` : ''}
            </span>
            <span class="clip-file-name">${escapeHtml(clip.fileName || 'Replay')}</span>
            ${clip.hit?.breakTitle || clip.currentBreak ? `
              <span class="clip-break-name">${escapeHtml(clip.hit?.breakTitle || clip.currentBreak)}</span>
            ` : ''}
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

      const rename = document.createElement('button');
      rename.className = 'ghost';
      rename.textContent = 'Rename Room';
      rename.addEventListener('click', () => renameRoomDisplay(room));
      bar.append(rename);

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


window.startSwishControl?.();
