// Windows-only TikTok compatibility.
// TikTok's iPhone/Safari presentation can render incorrectly inside Electron on Windows.
// Keep Mac behavior unchanged, but identify TikTok as Android Chrome on Windows so it
// receives a Chromium-compatible mobile layout inside the existing 9:16 wall frame.

const WINDOWS_TIKTOK_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro Build/AP4A.250105.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36';
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
