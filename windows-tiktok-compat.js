// Windows-only TikTok compatibility.
// TikTok's iPhone/Safari presentation can render incorrectly inside Electron on Windows.
// Keep Mac behavior unchanged, but identify TikTok as standard Android Chrome on Windows.
// Avoid the Android WebView markers ("wv" / Version/4.0) because TikTok can route auth
// through a restricted embedded-webview flow that breaks or degrades login.

const WINDOWS_TIKTOK_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP4A.250105.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const swishDefaultUserAgentFor = userAgentFor;

userAgentFor = function userAgentForWindowsTikTok(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const isTikTok = host === 'tiktok.com' || host.endsWith('.tiktok.com');
    const isWindows = /Windows/i.test(navigator.userAgent);
    if (isTikTok && isWindows) return WINDOWS_TIKTOK_UA;
  } catch (_) {}

  return swishDefaultUserAgentFor(url);
};
