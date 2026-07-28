# JourneyTracker

A Chrome extension that tracks your job application journey. It reads job
postings as you browse them, pre-fills an application record in the side panel,
and keeps the whole history on your own machine.

There is no server and no account. Nothing is transmitted anywhere.

## Status

**Phase 1 — schema and storage.** The extension loads, and the side panel talks
to the service worker over the real message layer: database open, migrations,
storage-protection check, request round-trip. The panel is still a diagnostic
readout rather than the product UI — the application form arrives in phase 3.
See `docs/ROADMAP.md` for the phase plan and `docs/DECISIONS.md` for the
architecture decisions behind it.

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
docs/DECISIONS.md          architecture decisions and their revisit conditions
```

## Privacy

The manifest requests three permissions, and no host permissions at all:

| Permission | Why |
|---|---|
| `sidePanel` | the UI surface |
| `storage` | settings (records live in IndexedDB) |
| `unlimitedStorage` | exempts the extension from storage quota **and** from Chrome's LRU eviction, so a job-search history that exists nowhere else cannot be silently cleared under disk pressure |

None of these grant access to page content. There are no content scripts yet;
when extraction lands in phase 4 they will be matched against specific job-board
domains rather than all sites, and anywhere else capture will be click-initiated
through `activeTab`, which needs no host permission at all.

Nothing is sent off the machine, and there is no analytics of any kind.

Captured records stay in IndexedDB on your device. Exports are the only way data
leaves, they are initiated by you, and the `lean` variant omits the raw page
snapshots so a backup can be shared without carrying anything scraped from a
logged-in session.
