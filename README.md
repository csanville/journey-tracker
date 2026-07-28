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
See `docs/ROADMAP.md` for the full phase plan.

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
On WSL, see below — `dist/` is the one path Chrome has trouble reaching.

### Loading from WSL

Chrome runs on the Windows host while this code lives in Linux. Chrome's **Load
unpacked** button opens a native Windows folder picker, and that picker does not
reliably reach the WSL share — the Linux entry is frequently missing from its
sidebar. So build to the Windows filesystem instead:

```bash
npm run build:win
```

That typechecks, builds, and prints the Windows path to select — by default
`C:\Users\<you>\JourneyTracker-dist`. Set `JT_WIN_DIST` to put it elsewhere,
as a Linux path (`/mnt/c/Users/you/...`, not `C:\Users\you\...`). The script
empties its output directory, so it refuses any destination that exists and
does not already contain a build.

Re-run it after every change and hit the reload icon on the extension card;
there is no need to remove and re-add the extension. There is no watch mode
here — `npm run dev` has one, but its output lands in `dist/`, which is the
directory Chrome cannot reliably load from on WSL.

Pasting the UNC path `\\wsl.localhost\Ubuntu\home\chase\projects\JourneyTracker\dist`
into the picker's folder field sometimes works too, but Chrome is inconsistent
about loading extensions from network paths, so the Windows-side build is the
one to rely on.

## Layout

```
manifest.json              MV3 manifest — permissions live here, keep them narrow
vite.config.ts             Vite + CRXJS
src/background/            service worker
src/sidepanel/             the panel UI
tools/make-icons.py        regenerates public/icons/*.png
tools/build-win.sh         builds to the Windows filesystem, for WSL
docs/ROADMAP.md            the phase plan
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
domains rather than all sites, and scanning any other site will be an optional
permission you grant deliberately.

Nothing is sent off the machine, and there is no analytics of any kind.
