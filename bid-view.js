// Platform-specific wall viewing helpers.
// Fanatics: keep native auction data visible and bring the live bid area into view.
// TikTok: focus the webview on the live video without treating TikTok like a bid platform.

const bidViewState = new Map();
const tiktokLiveViewState = new Map();

function bidViewEnabled(streamId) {
  return bidViewState.get(streamId) === true;
}

function bidViewSupported(stream) {
  return platformFor(stream) === 'Fanatics';
}

function tiktokLiveViewEnabled(streamId) {
  return tiktokLiveViewState.has(streamId) ? tiktokLiveViewState.get(streamId) === true : true;
}

function fanaticsBidInjection(enabled) {
  return `
    (() => {
      const STYLE_ID = 'swish-fanatics-bid-style';
      const BID_CLASS = 'swish-bid-emphasis';
      const enabled = ${enabled ? 'true' : 'false'};

      const cleanup = () => {
        document.getElementById(STYLE_ID)?.remove();
        document.querySelectorAll('.' + BID_CLASS).forEach((el) => el.classList.remove(BID_CLASS));
        if (window.__swishFanaticsBidObserver) {
          window.__swishFanaticsBidObserver.disconnect();
          window.__swishFanaticsBidObserver = null;
        }
        if (window.__swishFanaticsBidTimer) {
          clearTimeout(window.__swishFanaticsBidTimer);
          window.__swishFanaticsBidTimer = null;
        }
      };

      if (!enabled) {
        cleanup();
        return;
      }

      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '.' + BID_CLASS + ' {',
          '  position: relative !important;',
          '  z-index: 2147483000 !important;',
          '  font-weight: 900 !important;',
          '  font-size: max(22px, 1.35em) !important;',
          '  line-height: 1.05 !important;',
          '  text-shadow: 0 1px 3px rgba(0,0,0,.9) !important;',
          '}',
          'html, body { scrollbar-width: none !important; }',
          'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }'
        ].join('\\n');
        document.documentElement.appendChild(style);
      }

      const visible = (el) => {
        if (!(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      const semanticText = (el) => [
        el.id,
        typeof el.className === 'string' ? el.className : '',
        el.getAttribute?.('data-testid'),
        el.getAttribute?.('data-test-id'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title'),
        String(el.textContent || '').slice(0, 180)
      ].filter(Boolean).join(' ');

      const scoreBidCandidate = (el) => {
        if (!visible(el)) return -1;
        const text = semanticText(el);
        let score = 0;
        if (/(current bid|high bid|highest bid|winning bid|bid now|auction|bids?)/i.test(text)) score += 10;
        if (/\\$\\s?[0-9][0-9,.]*/.test(text)) score += 6;
        if (/(time left|seconds|ending|ends in|countdown)/i.test(text)) score += 4;
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 45) score += 2;
        if (r.width > window.innerWidth * 0.9 || r.height > window.innerHeight * 0.8) score -= 6;
        return score;
      };

      const emphasizeBidText = () => {
        document.querySelectorAll('body *').forEach((el) => {
          if (!visible(el) || el.children.length > 6) return;
          const text = String(el.textContent || '').trim().replace(/\\s+/g, ' ');
          if (!text || text.length > 100) return;
          if (/(current bid|high bid|highest bid|winning bid|bid now|\\$[0-9][0-9,.]*)/i.test(text)) {
            el.classList.add(BID_CLASS);
          }
        });
      };

      const horizontalScrollers = () => [...document.querySelectorAll('body *')].filter((el) => {
        if (!visible(el)) return false;
        const s = getComputedStyle(el);
        const overflowX = s.overflowX;
        return el.scrollWidth > el.clientWidth + 40 && /(auto|scroll)/.test(overflowX);
      });

      const bringAuctionIntoView = () => {
        const candidates = [...document.querySelectorAll('div,section,aside,article,[role="region"],[role="dialog"]')]
          .map((el) => ({ el, score: scoreBidCandidate(el) }))
          .filter((item) => item.score >= 10)
          .sort((a, b) => b.score - a.score);

        const best = candidates[0]?.el;
        if (best) {
          try { best.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' }); } catch (_) {}
          let parent = best.parentElement;
          for (let i = 0; i < 7 && parent; i += 1, parent = parent.parentElement) {
            if (parent.scrollWidth > parent.clientWidth + 40) {
              const target = Math.max(0, best.offsetLeft - Math.max(0, (parent.clientWidth - best.clientWidth) / 2));
              parent.scrollLeft = target;
            }
          }
          return;
        }

        // Fanatics' mobile page can place the auction panel at the far right of
        // a horizontally scrolling shell. If we cannot identify the panel by
        // text, move the strongest horizontal scroller to its right edge.
        const scrollers = horizontalScrollers()
          .map((el) => ({ el, range: el.scrollWidth - el.clientWidth }))
          .sort((a, b) => b.range - a.range);
        if (scrollers[0]?.el) scrollers[0].el.scrollLeft = scrollers[0].el.scrollWidth;
      };

      const apply = () => {
        emphasizeBidText();
        bringAuctionIntoView();
      };

      apply();
      if (!window.__swishFanaticsBidObserver) {
        window.__swishFanaticsBidObserver = new MutationObserver(() => {
          if (window.__swishFanaticsBidTimer) return;
          window.__swishFanaticsBidTimer = setTimeout(() => {
            window.__swishFanaticsBidTimer = null;
            apply();
          }, 250);
        });
        window.__swishFanaticsBidObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      }
    })();
  `;
}

function tiktokLiveInjection(enabled) {
  return `
    (() => {
      const STYLE_ID = 'swish-tiktok-live-style';
      const HIDDEN = 'data-swish-tiktok-hidden';
      const enabled = ${enabled ? 'true' : 'false'};

      const restore = () => {
        document.getElementById(STYLE_ID)?.remove();
        document.querySelectorAll('[' + HIDDEN + '="1"]').forEach((el) => {
          el.style.removeProperty('display');
          el.removeAttribute(HIDDEN);
        });
        if (window.__swishTikTokLiveObserver) {
          window.__swishTikTokLiveObserver.disconnect();
          window.__swishTikTokLiveObserver = null;
        }
        if (window.__swishTikTokLiveTimer) {
          clearTimeout(window.__swishTikTokLiveTimer);
          window.__swishTikTokLiveTimer = null;
        }
      };

      if (!enabled) {
        restore();
        return;
      }

      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          'html, body { background:#000 !important; scrollbar-width:none !important; }',
          'html::-webkit-scrollbar, body::-webkit-scrollbar { display:none !important; }',
          'video { max-width:100% !important; }'
        ].join('\\n');
        document.documentElement.appendChild(style);
      }

      const visible = (el) => {
        if (!(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      const largestVideo = () => [...document.querySelectorAll('video')]
        .filter(visible)
        .map((video) => ({ video, area: video.getBoundingClientRect().width * video.getBoundingClientRect().height }))
        .sort((a, b) => b.area - a.area)[0]?.video || null;

      const focusVideo = () => {
        const video = largestVideo();
        if (!video) return;
        const before = video.getBoundingClientRect();

        // Hide only obvious TikTok chrome that sits completely above the live
        // video. Avoid touching overlays on top of the video itself.
        document.querySelectorAll('header,[role="banner"],[data-e2e*="header" i],[data-e2e*="user-info" i],[data-e2e*="profile" i]').forEach((el) => {
          if (!visible(el) || el.getAttribute(HIDDEN) === '1') return;
          const r = el.getBoundingClientRect();
          if (r.bottom <= before.top + 4 && r.height < window.innerHeight * 0.38) {
            el.setAttribute(HIDDEN, '1');
            el.style.setProperty('display', 'none', 'important');
          }
        });

        try { video.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' }); } catch (_) {}

        let parent = video.parentElement;
        for (let i = 0; i < 8 && parent; i += 1, parent = parent.parentElement) {
          if (parent.scrollHeight > parent.clientHeight + 40) {
            const pr = parent.getBoundingClientRect();
            const vr = video.getBoundingClientRect();
            parent.scrollTop += vr.top - pr.top - 4;
          }
        }
      };

      focusVideo();
      if (!window.__swishTikTokLiveObserver) {
        window.__swishTikTokLiveObserver = new MutationObserver(() => {
          if (window.__swishTikTokLiveTimer) return;
          window.__swishTikTokLiveTimer = setTimeout(() => {
            window.__swishTikTokLiveTimer = null;
            focusVideo();
          }, 500);
        });
        window.__swishTikTokLiveObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
    })();
  `;
}

function executeInTile(streamId, script) {
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(streamId)}"]`);
  const view = tile?.querySelector('webview');
  if (!view) return;
  try { view.executeJavaScript(script).catch(() => {}); } catch (_) {}
}

function applyBidViewToStream(streamId) {
  const stream = streams.find((candidate) => candidate.id === streamId);
  if (!stream || !bidViewSupported(stream)) return;
  executeInTile(streamId, fanaticsBidInjection(bidViewEnabled(streamId)));
}

function applyTikTokLiveView(streamId) {
  const stream = streams.find((candidate) => candidate.id === streamId);
  if (!stream || platformFor(stream) !== 'TikTok') return;
  executeInTile(streamId, tiktokLiveInjection(tiktokLiveViewEnabled(streamId)));
}

function updateBidButton(tile, enabled) {
  const button = tile?.querySelector('.bid-view-toggle');
  if (!button) return;
  button.textContent = enabled ? 'BID ON' : 'BID';
  button.title = enabled ? 'Return Fanatics to normal view' : 'Bring the live Fanatics auction panel into view';
  button.setAttribute('aria-label', button.title);
  button.style.fontWeight = enabled ? '900' : '';
  button.style.background = enabled ? 'rgba(255,255,255,.16)' : '';
  button.style.borderColor = enabled ? 'rgba(255,255,255,.38)' : '';
}

function updateTikTokLiveButton(tile, enabled) {
  const button = tile?.querySelector('.tiktok-live-toggle');
  if (!button) return;
  button.textContent = enabled ? 'LIVE ON' : 'LIVE';
  button.title = enabled ? 'Show the normal TikTok page' : 'Focus on the TikTok live video';
  button.setAttribute('aria-label', button.title);
  button.style.fontWeight = enabled ? '900' : '';
  button.style.background = enabled ? 'rgba(255,255,255,.16)' : '';
  button.style.borderColor = enabled ? 'rgba(255,255,255,.38)' : '';
}

function setBidView(streamId, enabled) {
  bidViewState.set(streamId, Boolean(enabled));
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(streamId)}"]`);
  updateBidButton(tile, Boolean(enabled));
  applyBidViewToStream(streamId);
}

function setTikTokLiveView(streamId, enabled) {
  tiktokLiveViewState.set(streamId, Boolean(enabled));
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(streamId)}"]`);
  updateTikTokLiveButton(tile, Boolean(enabled));
  applyTikTokLiveView(streamId);
}

function attachPlatformViewControl(tile, stream) {
  if (!tile) return tile;
  const controls = tile.querySelector('.stream-controls');
  const view = tile.querySelector('webview');
  if (!controls || !view) return tile;

  if (bidViewSupported(stream) && !controls.querySelector('.bid-view-toggle')) {
    const button = document.createElement('button');
    button.className = 'micro-btn bid-view-toggle';
    updateBidButton({ querySelector: () => button }, bidViewEnabled(stream.id));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setBidView(stream.id, !bidViewEnabled(stream.id));
    });
    const audioButton = controls.querySelector('.audio-toggle');
    if (audioButton?.nextSibling) controls.insertBefore(button, audioButton.nextSibling);
    else controls.prepend(button);
  }

  if (platformFor(stream) === 'TikTok' && !controls.querySelector('.tiktok-live-toggle')) {
    const button = document.createElement('button');
    button.className = 'micro-btn tiktok-live-toggle';
    updateTikTokLiveButton({ querySelector: () => button }, tiktokLiveViewEnabled(stream.id));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setTikTokLiveView(stream.id, !tiktokLiveViewEnabled(stream.id));
    });
    const audioButton = controls.querySelector('.audio-toggle');
    if (audioButton?.nextSibling) controls.insertBefore(button, audioButton.nextSibling);
    else controls.prepend(button);
  }

  const reapply = () => {
    if (bidViewSupported(stream) && bidViewEnabled(stream.id)) setTimeout(() => applyBidViewToStream(stream.id), 300);
    if (platformFor(stream) === 'TikTok' && tiktokLiveViewEnabled(stream.id)) setTimeout(() => applyTikTokLiveView(stream.id), 450);
  };
  view.addEventListener('dom-ready', reapply);
  view.addEventListener('did-finish-load', reapply);
  return tile;
}

if (typeof buildLegacyWallTile === 'function') {
  const buildLegacyWallTileBeforePlatformView = buildLegacyWallTile;
  buildLegacyWallTile = function buildLegacyWallTileWithPlatformView(stream) {
    return attachPlatformViewControl(buildLegacyWallTileBeforePlatformView(stream), stream);
  };
}

try {
  streams.forEach((stream) => {
    const tile = els.wallGrid?.querySelector(`.stream-tile[data-stream-id="${CSS.escape(stream.id)}"]`);
    if (tile) attachPlatformViewControl(tile, stream);
  });
} catch (_) {}
