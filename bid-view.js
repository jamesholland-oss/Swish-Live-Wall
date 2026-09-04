// Optional Bid View for Fanatics / Whatnot wall tiles.
// This is intentionally conservative: it only changes the page while the
// operator has Bid View enabled, and all injected changes are reversible.

const bidViewState = new Map();

function bidViewEnabled(streamId) {
  return bidViewState.get(streamId) === true;
}

function bidViewSupported(stream) {
  const platform = platformFor(stream);
  return platform === 'Fanatics' || platform === 'Whatnot';
}

function bidViewInjection(enabled, platform) {
  return `
    (() => {
      const STYLE_ID = 'swish-bid-view-style';
      const HIDDEN = 'data-swish-bid-hidden';
      const PREV_DISPLAY = 'data-swish-prev-display';
      const BID_CLASS = 'swish-bid-emphasis';
      const enabled = ${enabled ? 'true' : 'false'};
      const platform = ${JSON.stringify(platform)};

      const restore = () => {
        document.querySelectorAll('[' + HIDDEN + '="1"]').forEach((el) => {
          const previous = el.getAttribute(PREV_DISPLAY);
          el.style.removeProperty('display');
          if (previous) el.style.setProperty('display', previous);
          el.removeAttribute(HIDDEN);
          el.removeAttribute(PREV_DISPLAY);
        });
        document.querySelectorAll('.' + BID_CLASS).forEach((el) => el.classList.remove(BID_CLASS));
        document.getElementById(STYLE_ID)?.remove();
        if (window.__swishBidObserver) {
          window.__swishBidObserver.disconnect();
          window.__swishBidObserver = null;
        }
        if (window.__swishBidTimer) {
          clearTimeout(window.__swishBidTimer);
          window.__swishBidTimer = null;
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
          '.' + BID_CLASS + ' {',
          '  position: relative !important;',
          '  z-index: 2147483000 !important;',
          '  font-weight: 900 !important;',
          '  font-size: max(22px, 1.45em) !important;',
          '  line-height: 1.05 !important;',
          '  text-shadow: 0 1px 3px rgba(0,0,0,.85) !important;',
          '}',
          '[data-swish-bid-hidden="1"] { display: none !important; }'
        ].join('\\n');
        document.documentElement.appendChild(style);
      }

      const semanticText = (el) => [
        el.id,
        typeof el.className === 'string' ? el.className : '',
        el.getAttribute?.('data-testid'),
        el.getAttribute?.('data-test-id'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title')
      ].filter(Boolean).join(' ');

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      const hideChat = () => {
        const all = document.querySelectorAll('div,aside,section,ul,ol,[role="log"],[role="feed"]');
        all.forEach((el) => {
          if (el.getAttribute(HIDDEN) === '1') return;
          const semantic = semanticText(el);
          if (!/(chat|comments?|message[-_ ]?(list|feed|panel)?|live[-_ ]?chat)/i.test(semantic)) return;
          if (/(bid|auction|price|product|offer)/i.test(semantic)) return;
          if (!isVisible(el)) return;
          const r = el.getBoundingClientRect();
          if (r.width < window.innerWidth * 0.22 || r.height < window.innerHeight * 0.08) return;
          el.setAttribute(PREV_DISPLAY, el.style.getPropertyValue('display') || '');
          el.setAttribute(HIDDEN, '1');
          el.style.setProperty('display', 'none', 'important');
        });

        // A few providers expose the chat region semantically even when the
        // CSS classes are generated. Hide the nearest substantial container.
        document.querySelectorAll('[aria-label*="chat" i],[title*="chat" i],[data-testid*="chat" i],[data-test-id*="chat" i]').forEach((marker) => {
          if (!isVisible(marker)) return;
          let target = marker;
          for (let i = 0; i < 4 && target.parentElement; i += 1) {
            const parent = target.parentElement;
            const r = parent.getBoundingClientRect();
            if (r.width >= window.innerWidth * 0.3 && r.height >= window.innerHeight * 0.12) target = parent;
            else break;
          }
          const semantic = semanticText(target);
          if (/(bid|auction|price|product|offer)/i.test(semantic)) return;
          if (target.getAttribute(HIDDEN) === '1') return;
          target.setAttribute(PREV_DISPLAY, target.style.getPropertyValue('display') || '');
          target.setAttribute(HIDDEN, '1');
          target.style.setProperty('display', 'none', 'important');
        });
      };

      const emphasizeBid = () => {
        document.querySelectorAll('body *').forEach((el) => {
          if (!isVisible(el) || el.children.length > 5) return;
          const text = String(el.textContent || '').trim().replace(/\\s+/g, ' ');
          if (!text || text.length > 80) return;
          const semantic = semanticText(el);
          const looksLikeBid = /(^|\\b)(current bid|high bid|highest bid|winning bid|your bid|bid now)(\\b|:)/i.test(text + ' ' + semantic);
          const looksLikeMoney = /^\\$[0-9][0-9,.]*$/.test(text);
          if (looksLikeBid || looksLikeMoney) el.classList.add(BID_CLASS);
        });
      };

      const apply = () => {
        hideChat();
        emphasizeBid();
      };

      apply();
      if (!window.__swishBidObserver) {
        window.__swishBidObserver = new MutationObserver(() => {
          if (window.__swishBidTimer) return;
          window.__swishBidTimer = setTimeout(() => {
            window.__swishBidTimer = null;
            apply();
          }, 150);
        });
        window.__swishBidObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      }
    })();
  `;
}

function applyBidViewToStream(streamId) {
  const stream = streams.find((candidate) => candidate.id === streamId);
  if (!stream || !bidViewSupported(stream)) return;
  const tile = els.wallGrid.querySelector(`.stream-tile[data-stream-id="${CSS.escape(streamId)}"]`);
  const view = tile?.querySelector('webview');
  if (!view) return;
  try {
    view.executeJavaScript(bidViewInjection(bidViewEnabled(streamId), platformFor(stream))).catch(() => {});
  } catch (_) {}
}

function updateBidButton(tile, enabled) {
  const button = tile?.querySelector('.bid-view-toggle');
  if (!button) return;
  button.textContent = enabled ? 'BID ON' : 'BID';
  button.title = enabled ? 'Turn Bid View off' : 'Hide chat and emphasize bid information';
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

function attachBidViewControl(tile, stream) {
  if (!tile || !bidViewSupported(stream)) return tile;
  const controls = tile.querySelector('.stream-controls');
  if (!controls || controls.querySelector('.bid-view-toggle')) return tile;

  const button = document.createElement('button');
  button.className = 'micro-btn bid-view-toggle';
  updateBidButton({ querySelector: () => button }, bidViewEnabled(stream.id));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setBidView(stream.id, !bidViewEnabled(stream.id));
  });

  // Put Bid View immediately after audio so it is easy to find on the wall.
  const audioButton = controls.querySelector('.audio-toggle');
  if (audioButton?.nextSibling) controls.insertBefore(button, audioButton.nextSibling);
  else if (audioButton) controls.appendChild(button);
  else controls.prepend(button);

  const view = tile.querySelector('webview');
  const reapply = () => {
    if (bidViewEnabled(stream.id)) setTimeout(() => applyBidViewToStream(stream.id), 250);
  };
  view?.addEventListener('dom-ready', reapply);
  view?.addEventListener('did-finish-load', reapply);
  return tile;
}

// Extend the proven compatibility tile builder without changing stream
// lifecycle, user agents, sessions, filters, audio, or fullscreen behavior.
if (typeof buildLegacyWallTile === 'function') {
  const buildLegacyWallTileBeforeBidView = buildLegacyWallTile;
  buildLegacyWallTile = function buildLegacyWallTileWithBidView(stream) {
    return attachBidViewControl(buildLegacyWallTileBeforeBidView(stream), stream);
  };
}

// If the wall was already built before this file loaded, decorate it in place.
try {
  streams.forEach((stream) => {
    const tile = els.wallGrid?.querySelector(`.stream-tile[data-stream-id="${CSS.escape(stream.id)}"]`);
    if (tile) attachBidViewControl(tile, stream);
  });
} catch (_) {}
