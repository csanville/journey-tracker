# JourneyTracker

A Chrome extension that tracks your job application journey. It reads job
postings as you browse them, pre-fills an application record in the side panel,
and keeps the whole history on your own machine.

There is no server and no account. Nothing is transmitted anywhere.

## Status

**Phase 7 — the dashboard.** The panel's **Dashboard** link opens a tab showing
what the saved records add up to: how many you have applied to against how many
you only looked at, tracking and applying week by week or month by month, and
which boards your applications actually came from. It updates as you save,
without a refresh.

Anything the charts cannot place is stated rather than dropped — an application
with no date recorded, or records older than the window shown — so the figures
never quietly disagree with each other.

Before that: a Backup drawer that writes your whole history to a file and reads
it back.

- **Export records** — JSON, records only. This is the portable one: no page
  content, safe to keep anywhere.
- **Export with pages** — the same records plus the trimmed pages they were read
  from, so a future parser fix can be replayed against what the page actually
  said. These came off logged-in sessions, so it is the copy to keep to yourself.
- **Spreadsheet** — a CSV report that opens straight in Excel. One-way: it is for
  reading, and cannot be imported.
- **Import** — records already on this machine are kept exactly as they are; a
  backup never overwrites them.
- **Erase everything** — behind a confirmation, because the way to find out a
  backup is real is to wipe and restore it.

Before that: postings are read off Greenhouse and Lever automatically, any other
page by right-clicking it, the form follows as you tab between postings without
ever clobbering what you have typed, and a page you have already tracked says so
— in the panel and on the toolbar badge — before you type a thing.

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
src/dashboard/             the dashboard page, and its read-only DB connection
src/styles/tokens.css      the palette, shared by both surfaces
src/lib/                   schema, storage, message layer
src/lib/dashboard/         the dashboard's arithmetic, apart from its rendering
src/lib/normalize/         join-key derivation — company, URL, ATS req id
src/lib/extract/           tiered adapters, snapshot trimming
src/lib/backup/            the export file format, its validator, the CSV report
src/test/fixtures/         real captured job pages the adapters are tested against
tools/make-icons.py        regenerates public/icons/*.png
tools/build-win.sh         builds to the Windows filesystem, for WSL
.prettierrc.json           formatting; run `npm run format` before committing
docs/ROADMAP.md            the phase plan
docs/DECISIONS.md          architecture decisions and their revisit conditions
```

## Privacy

The manifest requests six permissions, and no host permissions at all:

| Permission | Why |
|---|---|
| `sidePanel` | the UI surface |
| `storage` | settings (records live in IndexedDB) |
| `unlimitedStorage` | exempts the extension from storage quota **and** from Chrome's LRU eviction, so a job-search history that exists nowhere else cannot be silently cleared under disk pressure |
| `activeTab` | reading a page you explicitly asked to have read, and only that page |
| `scripting` | injecting the reader into it |
| `contextMenus` | the right-click item that asks for the read — the only discoverable gesture Chrome grants `activeTab` through |

None of these grants standing access to page content. Automatic reading happens
only on the three job-board hosts named in `content_scripts.matches`; anywhere
else it is click-initiated through `activeTab`, which reaches one tab, once, at
your request.

Nothing is sent off the machine, and there is no analytics of any kind.

Captured records stay in IndexedDB on your device. Exports are the only way data
leaves, they are initiated by you, and the records-only variant omits the raw
page snapshots so a backup can be shared without carrying anything scraped from a
logged-in session.
