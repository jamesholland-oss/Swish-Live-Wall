// Windows TikTok compatibility.
//
// The Mac wall is the proven reference. Keep the public TikTok live webview on
// the same mobile Safari identity used by the normal wall instead of inventing
// a Windows-only Android identity. Windows login is handled separately by the
// dedicated auth flow in windows-webview-polish.js, which temporarily uses a
// desktop Chromium identity while sharing the same persistent stream session.

const swishDefaultUserAgentFor = userAgentFor;

userAgentFor = function userAgentForWindowsTikTok(url) {
  // Deliberately return the proven V1.3/Mac identity for TikTok too.
  return swishDefaultUserAgentFor(url);
};
