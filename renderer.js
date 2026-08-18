let streams = [];
let selectedIndex = 0;
let fullscreenIndex = null;
let wallSuspended = false;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function userAgentFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'whatnot.com' || host.endsWith('.whatnot.com')) return DESKTOP_UA;
  } catch (_) {}
  return MOBILE_UA;
}

const grid = document.getElementById('grid');
const editor = document.getElementById('editor');
const editorRows = document.getElementById('editorRows');
const editBtn = document.getElementById('editBtn');
const closeEditorBtn = document.getElementById('closeEditorBtn');
const cancelBtn = document.getElementById('cancelBtn');
const saveBtn = document.getElementById('saveBtn');
const refreshAllBtn = document.getElementById('refreshAllBtn');
const muteAllBtn = document.getElementById('muteAllBtn');
const statusText = document.getElementById('statusText');

function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function pauseMedia(view) {
  if (!view || !view.executeJavaScript) return;
  view.executeJavaScript(`
    (() => {
      document.querySelectorAll('video,audio').forEach(el => {
        if (!el.paused) { el.dataset.swishWasPlaying = '1'; el.pause(); }
      });
    })();
  `).catch(() => {});
}

function resumeMedia(view) {
  if (!view || !view.executeJavaScript) return;
  view.executeJavaScript(`
    (() => {
      document.querySelectorAll('video,audio').forEach(el => {
        if (el.dataset.swishWasPlaying === '1') {
          delete el.dataset.swishWasPlaying;
          el.play().catch(() => {});
        }
      });
    })();
  `).catch(() => {});
}

function allViews() {
  return [...document.querySelectorAll('.tile webview')];
}

function suspendWall() {
  if (wallSuspended) return;
  wallSuspended = true;
  allViews().forEach(pauseMedia);
  if (statusText) statusText.textContent = 'PAUSED WHILE HIDDEN';
}

function resumeWall() {
  if (!wallSuspended) return;
  wallSuspended = false;
  allViews().forEach(resumeMedia);
  if (statusText) statusText.textContent = 'LOW-RESOURCE WALL';
}

function renderGrid() {
  grid.innerHTML = '';

  streams.forEach((stream, index) => {
    const tile = document.createElement('section');
    tile.className = 'tile' + (index === selectedIndex ? ' selected' : '');
    tile.dataset.index = index;

    const header = document.createElement('div');
    header.className = 'tile-header';

    const title = document.createElement('div');
    title.className = 'tile-title';
    title.textContent = stream.name || `Stream ${index + 1}`;

    const controls = document.createElement('div');
    controls.className = 'tile-controls';

    const refresh = document.createElement('button');
    refresh.textContent = '↻';
    refresh.title = 'Refresh this stream';
    refresh.addEventListener('click', (e) => {
      e.stopPropagation();
      const view = tile.querySelector('webview');
      if (view) view.reload();
    });

    const focus = document.createElement('button');
    focus.textContent = '⛶';
    focus.title = 'Enlarge this stream';
    focus.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(index);
    });

    controls.append(refresh, focus);
    header.append(title, controls);
    tile.append(header);

    const url = safeUrl(stream.url);
    if (url) {
      const stage = document.createElement('div');
      stage.className = 'phone-stage';

      const frame = document.createElement('div');
      frame.className = 'phone-frame';

      const view = document.createElement('webview');
      view.src = url;
      view.setAttribute('partition', 'persist:swish-live-wall');
      const ua = userAgentFor(url);
      view.setAttribute('useragent', ua);
      view.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes,spellcheck=no,backgroundThrottling=yes');
      view.addEventListener('dom-ready', () => {
        try {
          view.setAudioMuted(true);
          view.setUserAgent(ua);
          // Reduce small but unnecessary browser work inside an always-on wall.
          view.executeJavaScript(`
            (() => {
              document.querySelectorAll('video').forEach(v => {
                v.muted = true;
                v.disablePictureInPicture = true;
              });
            })();
          `).catch(() => {});
        } catch (_) {}
      });

      frame.append(view);
      stage.append(frame);
      tile.append(stage);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<div><strong>EMPTY SLOT</strong><br><br>Use Edit Streams to add a URL.</div>';
      tile.append(empty);
    }

    tile.addEventListener('mousedown', () => selectTile(index));
    grid.append(tile);
  });
}

function selectTile(index) {
  selectedIndex = index;
  document.querySelectorAll('.tile').forEach((tile, i) => {
    tile.classList.toggle('selected', i === selectedIndex);
  });
}

function toggleFullscreen(index) {
  const tiles = [...document.querySelectorAll('.tile')];
  const views = allViews();

  if (fullscreenIndex === index) {
    fullscreenIndex = null;
    document.body.classList.remove('focus-mode');
    tiles.forEach(t => t.classList.remove('fullscreen'));
    // Resume everything when returning to the 10-up wall.
    views.forEach(resumeMedia);
    if (statusText) statusText.textContent = 'LOW-RESOURCE WALL';
    return;
  }

  fullscreenIndex = index;
  selectedIndex = index;
  document.body.classList.add('focus-mode');
  tiles.forEach((tile, i) => {
    tile.classList.toggle('fullscreen', i === index);
    tile.classList.toggle('selected', i === index);
    const view = tile.querySelector('webview');
    if (!view) return;
    if (i === index) resumeMedia(view);
    else pauseMedia(view); // Biggest safe saving while a single feed is enlarged.
  });
  if (statusText) statusText.textContent = 'FOCUS MODE • OTHER FEEDS PAUSED';
}

function openEditor() {
  editorRows.innerHTML = '';
  streams.forEach((stream, index) => {
    const row = document.createElement('div');
    row.className = 'editor-row';
    row.innerHTML = `
      <div class="number">${index + 1}</div>
      <input class="name-input" data-index="${index}" value="${escapeAttr(stream.name || '')}" placeholder="Stream name" />
      <input class="url-input" data-index="${index}" value="${escapeAttr(stream.url || '')}" placeholder="https://..." />
    `;
    editorRows.append(row);
  });
  editor.classList.remove('hidden');
}

function closeEditor() {
  editor.classList.add('hidden');
}

function escapeAttr(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function saveEditor() {
  const next = streams.map((_, index) => ({
    name: document.querySelector(`.name-input[data-index="${index}"]`).value.trim() || `Stream ${index + 1}`,
    url: document.querySelector(`.url-input[data-index="${index}"]`).value.trim()
  }));

  streams = await window.swish.saveStreams(next);
  closeEditor();
  renderGrid();
}

function refreshAll() {
  allViews().forEach(view => view.reload());
}

function unmuteSelected() {
  const tiles = [...document.querySelectorAll('.tile')];
  tiles.forEach((tile, i) => {
    const view = tile.querySelector('webview');
    if (!view) return;
    try { view.setAudioMuted(i !== selectedIndex); } catch (_) {}
  });
  muteAllBtn.textContent = `Audio: ${streams[selectedIndex]?.name || `Stream ${selectedIndex + 1}`}`;
}

editBtn.addEventListener('click', openEditor);
closeEditorBtn.addEventListener('click', closeEditor);
cancelBtn.addEventListener('click', closeEditor);
saveBtn.addEventListener('click', saveEditor);
refreshAllBtn.addEventListener('click', refreshAll);
muteAllBtn.addEventListener('click', unmuteSelected);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fullscreenIndex !== null) toggleFullscreen(fullscreenIndex);
  if (e.key === 'Escape' && !editor.classList.contains('hidden')) closeEditor();
  if (e.key.toLowerCase() === 'r' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    refreshAll();
  }
});

// If the dashboard itself is minimized/hidden, stop all media decode until it
// becomes visible again. This matters for office machines where the wall may
// stay open all day but isn't always on screen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendWall();
  else resumeWall();
});

(async () => {
  streams = await window.swish.getStreams();
  renderGrid();
})();
