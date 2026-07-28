# JourneyTracker

A Chrome extension that tracks your job application journey. It reads job
postings as you browse them, pre-fills an application record in the side panel,
and keeps the whole history on your own machine.

There is no server and no account. Nothing is transmitted anywhere.

## Status

**Phase 0 — walking skeleton.** The extension loads, the side panel renders, and
it can reach `chrome.storage`. The application form arrives in phase 2. See
`docs/ROADMAP.md` for the full phase plan.

## Requirements

- Node 24 LTS (this repo was built against v24.18.0)
- Chrome 116 or newer (the side panel API needs 114; `sidePanel.open()` needs 116)

If you are on WSL, make sure `node` resolves inside Linux and not to a Windows
install — `which node` should print a path under `~/.nvm`, not `/mnt/c`. Running
the Windows `npm` from Linux writes Windows binaries into `node_modules` and
breaks the build in confusing ways.

## Getting started

```bash
npm install
npm run build
```

Then load it into Chrome:

1. Visit `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked**, and select the `dist/` directory
4. Click the JourneyTracker toolbar icon to open the side panel

`npm run dev` runs Vite with hot reload; point Chrome at `dist/` the same way.

### Loading from WSL

Chrome runs on the Windows host while the code lives in Linux, so browse to the
build output through the UNC path:

```
\\wsl.localhost\Ubuntu\home\chase\projects\JourneyTracker\dist
```

If Chrome refuses that path or reloads unreliably, build to the Windows
filesystem instead and load `C:\Users\chase\JourneyTracker-dist`:

```bash
npx vite build --outDir /mnt/c/Users/chase/JourneyTracker-dist --emptyOutDir
```

## Layout

```
manifest.json              MV3 manifest — permissions live here, keep them narrow
vite.config.ts             Vite + CRXJS
src/background/            service worker
src/sidepanel/             the panel UI
tools/make-icons.py        regenerates public/icons/*.png
docs/ROADMAP.md            the phase plan
```

## Privacy

The manifest requests only `sidePanel` and `storage`. Content scripts are
matched against specific job-board domains rather than all sites; scanning any
other site is an optional permission you grant deliberately. Nothing is sent off
the machine, and there is no analytics of any kind.
