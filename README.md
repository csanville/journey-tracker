# JourneyTracker

A Chrome extension that tracks your job application journey. It reads job
postings as you browse them, pre-fills an application record in the side panel,
and keeps the whole history on your own machine.

There is no server and no account. Nothing is transmitted anywhere.

## Status

**Phase 4 — extraction.** Open a Greenhouse or Lever posting and the panel offers
to fill the form from it: employer, role, location, work mode and salary where the
board states one, plus the posting's URL. The page it read is kept alongside the
record, trimmed, so a parser fix can be replayed against it later.

Filling is a button, not yet automatic — the panel checks the current tab when it
opens and when you click back into it. Following tabs as you switch between
postings is phase 5.

Everything from phase 3 is unchanged: a full form with dirty tracking, a
duplicate check before saving, and a save that clears the form for the next one.
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
On WSL, see below — `dist/` is the one path Chrome has trouble reaching.

The right-click capture needs a second bundle that `npm run dev` does not
build, so run `npm run dev:inject` alongside it in another terminal if you are
working on that path. Without it, capture fails with `Could not load file:
'injected.js'` — logged in the service worker console and nowhere else.
`npm run build` and `npm run build:win` both build it themselves.

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
src/content/               the reader that runs on a job page
src/sidepanel/             the panel UI
src/lib/                   schema, storage, message layer
src/lib/normalize/         join-key derivation — company, URL, ATS req id
src/lib/extract/           tiered adapters, snapshot trimming
src/test/fixtures/         real captured job pages the adapters are tested against
tools/make-icons.py        regenerates public/icons/*.png
tools/build-win.sh         builds to the Windows filesystem, for WSL
.prettierrc.json           formatting; run `npm run format` before committing
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
