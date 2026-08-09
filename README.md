# JourneyTracker

A Chrome extension that tracks your job application journey. It reads job
postings as you browse them, pre-fills an application record in the side panel,
and keeps the whole history on your own machine.

There is no server and no account. Nothing is transmitted anywhere.

## Status

**What happened after you applied.** An applied posting records how far it got
and how it ended, on two separate controls: a **stage** (screening, interviewing,
offer) and an **outcome** (rejected, withdrawn, accepted). They are separate
because the commonest result in a job search — rejected after two interviews —
needs both, and a single status list would throw one of them away.

Leaving them alone is the normal thing to do. Blank means "nothing heard yet"
and "still open", and how long something has been quiet is worked out from the
date you applied, so there is nothing to keep up to date.

**Any saved posting can be edited from the panel** — search for it by company or
title, change what you need, and save. That is what makes the two controls above
worth having: a rejection three weeks later goes onto the record it belongs to
rather than into a second copy of it. Records can be deleted from the same place.

The dashboard gained a section for it: how many applications got a reply, how
many reached an interview, how many ended in an offer, and how many are still
waiting on a first response after three weeks.

**On Greenhouse, the extension notices when an application goes in.** Submitting
one lands on a confirmation page, and if that posting is already saved the
extension asks whether to mark it applied. It asks rather than acting: a wrong
guess costs one dismissed banner.

The panel does not have to be open at the time — which is just as well, since
almost nobody has a side panel open while filling in an application form. The
question waits until you next open it, several of them queue up one at a time,
and answering sticks whether or not you say yes. The date recorded is the day the
confirmation page appeared, not the day you got round to answering, so the
"still waiting on a reply" figures stay honest. Unanswered questions are
forgotten after a fortnight, on the grounds that by then the answer would be a
guess.

This only works on Greenhouse, and that is a real limit rather than a gap to be
filled later. It is also a narrower claim than it looks: *reading* a posting
works on Lever and Ashby too, and it is only the moment of submission that
Greenhouse alone gives up.

Reading that moment needs the extension to be running on the page when it
happens, which it only is on the job boards listed under Privacy below.
Everywhere else — Workday, iCIMS, LinkedIn, a company's own careers page — the
honest answer is that it cannot see it, and reaching them would mean asking for
permission to read every site you visit. Lever is left out for a different
reason: employers there can send you anywhere after you apply, so there is
nothing dependable to watch for. Ashby is left out for a third — its application
form is drawn by JavaScript rather than served, so what the page does after a
successful submission has not been established, and a guessed-at signal would be
the kind of thing that gets recorded as working because it was written rather
than because it was watched.

Before that: the **Dashboard** link opens a tab showing what the saved records
add up to — how many you have applied to against how many you only looked at,
tracking and applying week by week or month by month, and which boards your
applications actually came from. It updates as you save, without a refresh.

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

Before that: postings are read off Greenhouse, Lever and Ashby automatically, any
other page by right-clicking it, the form follows as you tab between postings
without ever clobbering what you have typed, and a page you have already tracked says so
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

### Testing submission detection without applying to anything

Submission detection is a **URL match on page load**. It does not observe a form
being submitted, and nothing about it requires an application to have happened:

```
https://job-boards.greenhouse.io/<token>/jobs/<numeric id>/confirmation
```

The content script checks that shape on every load and every SPA navigation, and
the worker matches the derived posting URL against a stored record. So the whole
path runs if you:

1. **Save any Greenhouse posting** in the panel. Do not apply to it.
2. **Add `/confirmation` to the end of the _path_** — before any `?`, not after
   it — and navigate there.

```
posting   https://job-boards.greenhouse.io/otter/jobs/8355059002?gh_src=cca791e3
                                           └──────── path ──────┘└─── query ───┘

correct   https://job-boards.greenhouse.io/otter/jobs/8355059002/confirmation
wrong     https://job-boards.greenhouse.io/otter/jobs/8355059002?gh_src=cca791e3/confirmation
```

The second one is the mistake worth naming, because it fails *silently and
convincingly*: `confirmationTarget` reads `parsed.pathname`, which is still
`/otter/jobs/8355059002`, so it declines. Greenhouse ignores the mangled
`gh_src`, serves the same page without even a 404, and the content script parses
it happily under the new URL — so everything looks like it worked except the one
thing being tested. Drop the query string, or put it after `/confirmation`;
both are fine, since the query is discarded when the posting URL is derived.

That is the real end-to-end test — content script, worker, `findDuplicate`, the
pending store, the panel — and it is repeatable, because you can delete the
record and do it again. Close the side panel first if you want to test the case
the queue exists for.

One other thing to know: the prompt is only raised for a record that is not
already `applied`, so a record is spent once you confirm it — `jt.unapply()`
below puts it back.

For the states that recipe cannot reach — a confirmation dated days ago, an
expired one, or several queued at once without navigating repeatedly — paste
[`tools/pending-console.js`](tools/pending-console.js) into the DevTools console
of an **extension page** (the dashboard is convenient; a job board's console
cannot reach `chrome.storage`). It defines:

| | |
|---|---|
| `jt.list()` | saved postings, with ids |
| `jt.pending()` | the queue, with each entry's age and whether it has expired |
| `jt.queue(n)` | seed `n` questions a day apart, oldest asked first |
| `jt.add(id, daysAgo)` | one question, backdated — use `14` or more to test expiry |
| `jt.unapply(id)` | put a record back to `viewed` so it can be asked about again |
| `jt.clear()` | empty the queue |

Reopen the side panel after seeding; it reads the queue on mount.

It seeds the store rather than faking a confirmation to the worker, deliberately.
`application/submitted` takes its tab from `sender.tab`, which an extension page
does not have, so a "simulated" submission would be answered `{ matched: false }`
and would exercise a path the real one never takes.

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
tools/pending-console.js   drives the submission prompt without applying to jobs
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
only on the four job-board hosts named in `content_scripts.matches`; anywhere
else it is click-initiated through `activeTab`, which reaches one tab, once, at
your request.

Nothing is sent off the machine, and there is no analytics of any kind.

Captured records stay in IndexedDB on your device. Exports are the only way data
leaves, they are initiated by you, and the records-only variant omits the raw
page snapshots so a backup can be shared without carrying anything scraped from a
logged-in session.
