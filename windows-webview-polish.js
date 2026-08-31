// Windows-only visual polish for public stream webviews.
// Preserve page scroll behavior while hiding native Chromium scrollbar chrome
// and suppressing accidental horizontal overflow inside the 9:16 wall frames.

const swishCreateLegacyStreamWebview = createLegacyStreamWebview;

createLegacyStreamWebview = function createPolishedWindowsStreamWebview(stream) {
  const view = swishCreateLegacyStreamWebview(stream);
  if (!view) return view;

  const isWindows = /Windows/i.test(navigator.userAgent);
  if (!isWindows) return view;

  view.addEventListener('dom-ready', () => {
    const css = [
      'html, body {',
      '  max-width: 100vw !important;',
      '  overflow-x: hidden !important;',
      '  scrollbar-width: none !important;',
      '  -ms-overflow-style: none !important;',
      '}',
      'html::-webkit-scrollbar,',
      'body::-webkit-scrollbar,',
      '*::-webkit-scrollbar {',
      '  width: 0 !important;',
      '  height: 0 !important;',
      '  display: none !important;',
      '}'
    ].join('\\n');

    const script = `(() => {
      const id = 'swish-control-windows-polish';
      if (!document.getElementById(id)) {
        const style = document.createElement('style');
        style.id = id;
        style.textContent = ${JSON.stringify(css)};
        (document.head || document.documentElement).appendChild(style);
      }
    })();`;

    view.executeJavaScript(script).catch(() => {});
  });

  return view;
};
