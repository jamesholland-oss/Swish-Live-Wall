// Swish Control live auction header monitor.
// Fanatics and TikTok pages stay visually untouched. This reads only the
// currently-rendered bid and timer values and shows them beside the room name.

const auctionMonitorState = new Map();
let auctionMonitorBusy = false;

function auctionMonitorSupported(stream) {
  const platform = platformFor(stream);
  return platform === 'Fanatics' || platform === 'TikTok';
}

function auctionExtractionScript() {
  return `
    (() => {
      const visible = (el) => {
        if (!(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
      };

      const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const moneyMatches = (text) => [...String(text || '').matchAll(/\\$\\s*([0-9]{1,7}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)/g)]
        .map((m) => ({ raw: m[0].replace(/\\s+/g, ''), value: Number(m[1].replace(/,/g, '')) }))
        .filter((m) => Number.isFinite(m.value));

      const parseSeconds = (text) => {
        const value = String(text || '').toLowerCase();
        let match = value.match(/(?:time left|ends? in|ending in|remaining|countdown)[^0-9]{0,18}(\\d{1,2}):(\\d{2})/i);
        if (match) return Number(match[1]) * 60 + Number(match[2]);
        match = value.match(/(?:time left|ends? in|ending in|remaining|countdown)[^0-9]{0,18}(\\d{1,3})\\s*(?:s|sec|secs|second|seconds)\\b/i);
        if (match) return Number(match[1]);
        match = value.match(/\\b(\\d{1,2}):(\\d{2})\\b/);
        if (match) {
          const seconds = Number(match[1]) * 60 + Number(match[2]);
          if (seconds >= 0 && seconds <= 600) return seconds;
        }
        match = value.match(/\\b(\\d{1,3})\\s*(?:s|sec|secs|second|seconds)\\b/i);
        if (match) {
          const seconds = Number(match[1]);
          if (seconds >= 0 && seconds <= 600) return seconds;
        }
        return null;
      };

      const semantic = (el) => [
        el?.id,
        typeof el?.className === 'string' ? el.className : '',
        el?.getAttribute?.('data-testid'),
        el?.getAttribute?.('data-test-id'),
        el?.getAttribute?.('data-e2e'),
        el?.getAttribute?.('aria-label'),
        el?.getAttribute?.('title'),
        textOf(el)
      ].filter(Boolean).join(' ');

      const selectors = 'div,section,aside,article,button,[role="region"],[role="dialog"],[role="status"],span,p';
      const candidates = [];

      document.querySelectorAll(selectors).forEach((el) => {
        if (!visible(el)) return;
        const text = textOf(el);
        if (!text || text.length > 220) return;
        const combined = semantic(el);
        const money = moneyMatches(text);
        if (!money.length) return;

        let score = 0;
        if (/(current bid|current offer)/i.test(combined)) score += 40;
        if (/(highest bid|high bid|winning bid|top bid)/i.test(combined)) score += 34;
        if (/\\bbid\\b/i.test(combined)) score += 18;
        if (/\\bauction\\b/i.test(combined)) score += 12;
        if (/(time left|ends? in|ending in|remaining|countdown)/i.test(combined)) score += 14;
        if (/(retail|price|value|subtotal|shipping|total|balance)/i.test(combined) && !/\\bbid\\b/i.test(combined)) score -= 12;
        if (el.children.length <= 4) score += 3;

        const r = el.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.96 && r.height > window.innerHeight * 0.65) score -= 18;
        if (score > 0) candidates.push({ el, text, score, money });
      });

      candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
      const best = candidates.find((item) => item.score >= 18) || null;
      if (!best) return { bid: null, seconds: null, confidence: 0 };

      let bid = best.money[best.money.length - 1]?.raw || null;
      const bidPhrase = best.text.match(/(?:current bid|highest bid|high bid|winning bid|top bid|bid)\\D{0,24}(\\$\\s*[0-9][0-9,.]*)/i);
      if (bidPhrase) bid = bidPhrase[1].replace(/\\s+/g, '');

      let seconds = parseSeconds(best.text);
      if (seconds == null) {
        const timerCandidates = [];
        document.querySelectorAll(selectors).forEach((el) => {
          if (!visible(el)) return;
          const text = textOf(el);
          if (!text || text.length > 90) return;
          const parsed = parseSeconds(text);
          if (parsed == null) return;
          let score = 0;
          const combined = semantic(el);
          if (/(time left|ends? in|ending in|remaining|countdown)/i.test(combined)) score += 20;
          if (/\\bauction\\b|\\bbid\\b/i.test(combined)) score += 8;
          const br = best.el.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          const distance = Math.abs((er.top + er.height / 2) - (br.top + br.height / 2));
          if (distance < 250) score += 6;
          timerCandidates.push({ seconds: parsed, score });
        });
        timerCandidates.sort((a, b) => b.score - a.score);
        seconds = timerCandidates[0]?.seconds ?? null;
      }

      if (seconds != null && (seconds < 0 || seconds > 600)) seconds = null;
      return { bid, seconds, confidence: best.score };
    })();
  `;
}

function formatAuctionTimer(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 60) return `${Math.floor(value)}s`;
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function ensureAuctionBadge(tile) {
  if (!tile) return null;
  let badge = tile.querySelector('.swish-auction-badge');
  if (badge) return badge;

  const identity = tile.querySelector('.stream-identity');
  if (!identity) return null;

  badge = document.createElement('span');
  badge.className = 'swish-auction-badge';
  badge.style.cssText = [
    'display:none',
    'margin-left:10px',
    'padding:3px 7px',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:6px',
    'background:rgba(255,255,255,.08)',
    'font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:11px',
    'font-weight:800',
    'line-height:1',
    'letter-spacing:.01em',
    'white-space:nowrap'
  ].join(';');
  identity.appendChild(badge);
  return badge;
}

function renderAuctionState(streamId, data) {
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(streamId)}"]`);
  const badge = ensureAuctionBadge(tile);
  if (!badge) return;

  if (!data?.bid || data?.seconds == null) {
    badge.style.display = 'none';
    badge.textContent = '';
    return;
  }

  badge.textContent = `BID ${data.bid} • ${formatAuctionTimer(data.seconds)}`;
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
}

async function readAuctionState(stream) {
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(stream.id)}"]`);
  const view = tile?.querySelector('webview');
  if (!view) return null;

  try {
    const result = await view.executeJavaScript(auctionExtractionScript());
    if (!result || typeof result !== 'object') return null;
    return {
      bid: typeof result.bid === 'string' ? result.bid : null,
      seconds: Number.isFinite(Number(result.seconds)) ? Number(result.seconds) : null,
      confidence: Number(result.confidence || 0)
    };
  } catch (_) {
    return null;
  }
}

async function pollAuctionHeaders() {
  if (auctionMonitorBusy || !els?.wallGrid) return;
  auctionMonitorBusy = true;
  try {
    const supported = streams.filter(auctionMonitorSupported);
    for (const stream of supported) {
      const result = await readAuctionState(stream);
      const previous = auctionMonitorState.get(stream.id) || { misses: 0, data: null };

      if (result?.bid && result?.seconds != null && result.confidence >= 18) {
        const next = { misses: 0, data: result };
        auctionMonitorState.set(stream.id, next);
        renderAuctionState(stream.id, result);
      } else {
        const misses = previous.misses + 1;
        auctionMonitorState.set(stream.id, { ...previous, misses });
        if (misses >= 4) {
          auctionMonitorState.set(stream.id, { misses, data: null });
          renderAuctionState(stream.id, null);
        }
      }
    }
  } finally {
    auctionMonitorBusy = false;
  }
}

function attachAuctionMonitor(tile, stream) {
  if (!tile || !auctionMonitorSupported(stream)) return tile;
  ensureAuctionBadge(tile);
  const view = tile.querySelector('webview');
  const reset = () => {
    auctionMonitorState.set(stream.id, { misses: 0, data: null });
    renderAuctionState(stream.id, null);
  };
  view?.addEventListener('did-start-loading', reset);
  return tile;
}

if (typeof buildLegacyWallTile === 'function') {
  const buildLegacyWallTileBeforeAuctionMonitor = buildLegacyWallTile;
  buildLegacyWallTile = function buildLegacyWallTileWithAuctionMonitor(stream) {
    return attachAuctionMonitor(buildLegacyWallTileBeforeAuctionMonitor(stream), stream);
  };
}

try {
  streams.forEach((stream) => {
    const tile = els.wallGrid?.querySelector(`.stream-tile[data-stream-id="${CSS.escape(stream.id)}"]`);
    if (tile) attachAuctionMonitor(tile, stream);
  });
} catch (_) {}

setInterval(pollAuctionHeaders, 500);
setTimeout(pollAuctionHeaders, 800);
