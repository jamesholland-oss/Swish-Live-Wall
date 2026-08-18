# Swish Live Wall v1.3

A 10-up Electron multiview for monitoring the actual public Fanatics Live, Whatnot and TikTok viewer pages in a phone-oriented layout.

## What changed in v1.3

- Keeps all 10 public pages visible in the normal wall view.
- Keeps Fanatics/TikTok mobile user agents and Whatnot desktop Chrome behavior.
- All feeds start muted.
- Blank slots create no webview at all.
- Embedded pages cannot open extra popup windows.
- Camera, microphone, location, notification and other permissions are denied to embedded pages.
- Chromium disk/media caches are bounded.
- Spellcheck, translation/media-router/component-update overhead is disabled where safe.
- When you enlarge one stream, the other streams' HTML5 media elements are paused until you return to the wall.
- When the whole app is hidden/minimized, media is paused and resumes when visible again.
- macOS and Windows packaging scripts are included.
- Full source code stays editable.

## Important performance reality

The normal 10-up wall still loads up to ten real livestream webpages at the same time because the purpose of this app is to show what viewers actually see, including chat and platform UI. That has a real memory/CPU cost and cannot be made as light as ten raw video players without losing that viewer experience. v1.3 removes avoidable work without intentionally degrading the visible wall.

## Run from source

Install Node.js first, then from this folder:

```bash
npm install
npm start
```

## Build a real macOS app

On a Mac:

```bash
npm install
npm run dist:mac
```

Build output goes into `dist/`. It creates a DMG plus ZIP build.

Unsigned macOS apps may trigger Gatekeeper warnings on other Macs. For broad/internal distribution without warnings, add Apple Developer code signing/notarization later.

## Build a real Windows app

On Windows:

```powershell
npm install
npm run dist:win
```

Build output goes into `dist/`. It creates both an installer and a portable executable.

## Automatic Mac + Windows builds with GitHub

The repository includes `.github/workflows/build.yml`. Push this source to GitHub and either:

1. Run **Build Swish Live Wall** manually from the Actions tab, or
2. Create/push a tag such as `v1.3.0`.

GitHub Actions will build macOS and Windows artifacts separately. This avoids needing a Windows machine just to produce the Windows build.

## Edit stream URLs

Use **Edit Streams** inside the app. Stream configuration is stored in Electron's per-user app-data directory, not in the source folder, so app updates do not need to overwrite your saved URLs.

## Source layout

- `main.js` — Electron app/window/security/session setup
- `renderer.js` — stream grid, webviews, mobile/desktop UA handling, controls and performance behavior
- `preload.js` — safe IPC bridge
- `index.html` — app shell
- `styles.css` — layout and styling
- `package.json` — dependencies + Mac/Windows packaging
- `.github/workflows/build.yml` — automatic cross-platform builds

## v1.3 scope

This remains intentionally local. There is no database or central server yet. That makes it easier to test and integrate with other production software later without prematurely locking in an architecture.
