# Roadmap

`DECISIONS.md` records *what* was decided and why. This file sequences the work.
Where the two disagree, `DECISIONS.md` wins and this file gets fixed.

Phase 0 is on `main`. Every phase after it is built on its own branch, reviewed,
then merged.

| Phase | Branch | Scope | Done when |
|---|---|---|---|
| 0 ✅ | `main` | Node 24, CRXJS scaffold, MV3 manifest, side panel that probes storage | Panel opens in Chrome |
| 1 ✅ | `feat/schema-storage` | Dexie schema, migration harness, single-writer message layer, storage persistence | Tests green, no UI |
| 2 ✅ | `feat/normalization` | Company normalization, URL canonicalization, `atsReqId`, dedupe | Fixture tests green, no UI |
| 3 ✅ | `feat/sidepanel-form` | Full form, theme, manual save, dirty tracking, save → wipe → fresh form | Enter a job by hand; it survives a reload |
| 4 ✅ | `feat/extraction` | Tiered adapters, snapshots, adapter versioning, URL reporting that survives SPA navigation, fixture tests | A real posting fills the form |
| 5 ✅ | `feat/live-sync`, `feat/activetab-capture` | Tab listeners, swap rules, dirty banner, revisit warning, toolbar badge, `activeTab` capture for unknown sites | Tab between postings; the form follows, and a posting already tracked says so before you type |
| 6 ✅ | `feat/export-import` | JSON lean/full round-trip, CSV report, skip-duplicate import, snapshot retention sweep | Export, wipe, re-import — data identical |
| 7 ✅ | `feat/dashboard` | Extension-page dashboard; `liveQuery` over a schema-less read connection; status funnel, over time, per-board yield | Patterns visible across saved data |
| 8 ✅ | `feat/outcomes`, `feat/submit-detect` | Schema v3 `stage`/`outcome`; response funnel, endings and silence on the dashboard; Greenhouse confirmation-URL detection behind a prompt | The dashboard says what happened after you applied, and a real Greenhouse submission raises a prompt |
| 9 ✅ | `feat/edit-record` | Editing a saved posting from the panel — the capability phase 7's docs assumed already existed, and which phase 8's fields need to be worth anything; a filter to find the record, and delete | Change a record's stage and outcome weeks after saving it, without writing a second record |
| 10 ✅ | `feat/pending-submissions` | A confirmed submission survives a closed panel: a durable pending queue, an event demoted to a signal, and the confirmation's own timestamp on the record | Apply with the panel shut, open it later, and the question is waiting with the right date on it |
| — ✅ | `feat/ashby-adapter` | An Ashby adapter, on its own branch rather than as a phase — reading a fourth board is additive and needed no new mechanism | A posting on `jobs.ashbyhq.com` fills the form |
| 11 ✅ | `feat/diagnostics` | A diagnostics report the user can send: a pulled parse of the current page, an allowlisted payload shown before it is copied, and the retirement of re-parse | On a page the extension cannot read, one gesture produces a report that names the board and what each tier returned, and carries no company, title or URL path |
| 12 | `fix/fill-while-editing`, `feat/workday-adapter` | The fill that overwrites a record, closed by asking which record it means; and a Workday adapter, the first board whose host is per-tenant | Filling from a page while editing asks update-or-new and neither answer destroys a record; and a posting on `*.myworkdayjobs.com` fills the form |
| later | — | iCIMS, SmartRecruiters adapters | — |

## Known bugs

Open defects found by use and not yet fixed. Entries leave here by being fixed,
never by being explained.

### Filling from a page while editing a record overwrites that record

**Data loss. Found in the phase 11 walkthrough; present since phase 9, not
introduced by it — `PostingForm.tsx` is untouched on `feat/diagnostics`.**

Open a saved record for editing, then navigate to a Greenhouse or Ashby posting.
The panel offers "Fill from this page". Accept it: the form fills with the new
posting, and still holds the record being edited. Save, and the **new job's
details are written over the old record**, which is now a record of a job the
user never applied to, under an id they cannot reach any other way. The original
is gone.

The mechanism is three lines apart in one file. `openForEdit` sets `draftId` to
the stored record's id. `reset` is the only place that ever puts it back —
`setDraftId(newId())` and `setEdited(null)`, and its comment says so: "Every exit
from editing runs through here … so there is one place where the id stops being
the stored record's." `applyFill` is a fourth exit and does not run through it:
it replaces `draft` and sets `filled`, and touches neither `draftId` nor
`edited`. `save` then writes to `draftId`.

Two things make it worse than a wrong id:

- **The record is stamped as if it were captured.** `save` prefers `filled` over
  `edited` for provenance, so the overwritten record carries the new page's
  `source` and `adapterVersion`. It does not look like a mistake afterwards; it
  looks like a posting that was read off a board.
- **The duplicate check is skipped.** `if (!force && !edited)` — `edited` is
  still set, so the one thing that might have raised "you already saved this
  one" is disabled by the same stale state that causes the bug.

**What makes this worth writing down at length is that the guard exists, and is
correct, and is bypassed.** `swapAction` in `fill.ts` already refuses the
*automatic* swap while a record is held, and its comment describes this exact
outcome: "The form would silently repopulate … *while still holding the stored
record's id*, and the next save would write that other job over the record being
edited. Not a lost draft: a destroyed record." Having named it, it returns
`announce` rather than `nothing` so the banner survives — "Offer, never take."

The offer, when taken, takes. Phase 9 closed the automatic door, documented
precisely why the door was dangerous, and left the manual one open beside it.
That is a fifth shape for the list below, and the sharpest instance of any of
them: **a guard placed on one path to a hazard, where the other path is the one
the design deliberately kept open.** The check is to ask, for every guard, which
callers reach the guarded state *without* passing through it — and phase 9's own
comment is what makes the answer obvious in hindsight, because it named the
hazard and then described the surviving route to it in the next sentence.

Not fixed here because phase 11 is about to be reviewed and this is not its code.
The fix is small — `applyFill` has to let go of the record, which is `reset`'s
job — but the *behaviour* it should choose is not obvious and needs deciding:
filling from a page while editing might reasonably mean "update this record from
this page" rather than "start a new one", and those want different ids. That is a
phase-sized question, not a patch.

## Phase 1 — schema and storage

No UI, no parsing. This phase exists so that everything after it writes through
one enforced path.

- **Dexie schema.** `postings` and `snapshots` as separate object stores
  (decision 3); `chrome.storage.local` for settings only. `resumeUsed` is a label
  on the posting, not a store — there is no resume library (decision 11).
- **Record shape.** UUID `id`, `updatedAt`, `schemaVersion`, and the `viewed` /
  `applied` state distinction (decisions 8, 10). Join-key fields
  (`companyNormalized`, canonical `url`, `atsReqId`) are defined here and
  populated in phase 2.
- **Migration harness.** Forward-only, idempotent, on `onInstalled` with
  `reason === 'update'`, guarded by a `migrationInProgress` flag in
  `chrome.storage.local` that readers wait on (decision 9).
- **Single-writer message layer.** Typed request/response between panel and
  service worker; every mutation idempotent so a torn-down worker can be retried
  safely (decision 4).
- **Storage persistence.** Declare `unlimitedStorage`, which alone exempts an
  extension from eviction, and additionally call `navigator.storage.persist()`
  from the side panel — that call is `[Exposed=Window]`, so the worker can only
  read the state, not request it. Record both, warn only when neither holds.
  IndexedDB is evictable by default and this is the project's worst failure mode
  (decision 3).
- **Vitest**, against a fake-indexeddb backend so tests need no browser.

**Done when** the suite covers a round-trip write/read, a migration from a seeded
prior version, and a retried mutation that does not double-write.

## Phase 2 — normalization and join keys

Still no UI. Pure functions, heavily fixture-tested, because everything about
dedupe quality lives here.

- **Company normalization** — case, legal suffixes, punctuation, common aliases.
  Not a trim (decision 7).
- **URL canonicalization** — strip tracking parameters consistently so the same
  posting reached by different links collapses to one record.
- **`atsReqId` extraction** from Greenhouse, Lever, Ashby and Workday URL shapes.
- **Schema version 2**, with a migration that backfills the derived keys onto
  records written by a phase 1 build. The fields existed at version 1 but held
  whatever the caller sent; changing what they *mean* needs a migration exactly
  as much as changing their shape does (decision 9).
- **Dedupe** on canonical URL — when it is a real URL — falling back to
  `companyNormalized + atsReqId`, and then to `companyNormalized` plus a
  normalized title. `jobTitle` is absent from the *second* key on purpose: a
  requisition id is already unique within a company, so the title added no
  discriminating power there and only gave the match a way to fail when a board
  rewords its own listing. It earns its own third key because that one only
  raises a prompt, never merges (decision 7).

**Done when** a fixture set of messy real-world URLs and company strings collapses
to the expected records, including the near-miss cases that should *not* merge.

## Phase 3 — the side panel form

Written up after the fact, in phase 7, when it turned out to be the one phase
with no section. Reconstructed from the branch (`a634a7f`, `ce3ccdb`) and the
code rather than from memory.

The panel stops being a diagnostic readout and becomes the thing the extension is
for: fill in a job, save it, watch the form clear itself for the next one. No
parsing and no tab awareness — everything here is typed by hand, which is what
makes it the honest floor under the four phases that automate it.

- **The form's logic lives outside React.** `sidepanel/draft.ts` is plain
  functions over plain data: what counts as dirty, what an empty field means,
  and what shape reaches the database. Those are the parts worth getting right
  and they are far easier to test as functions than through a component, which
  leaves `PostingForm.tsx` thin enough to verify by using it. The same split is
  what phase 7's `lib/dashboard/aggregate.ts` does, for the same reason.
- **The draft id is fixed for the life of the draft**, not generated at save. A
  save retried after the duplicate prompt or after a failure must reuse it, or
  the retry writes a second record instead of being the no-op `upsertPosting` is
  built to make it (decision 4).
- **Saving checks for a duplicate first**, using the phase 2 keys, and offers the
  existing record rather than silently writing a second copy or silently
  refusing. The first place that work is visible — and the realisation that the
  same check is far more useful *before* the form is filled in is what put the
  revisit warning into phase 5.
- **Dirty tracking compares against a baseline, not against empty**, even though
  the baseline is always empty here. From phase 5 a pristine form is one that
  still matches what was auto-filled into it rather than one that is blank
  (decision 13), and this is the seam that makes that possible without rewriting
  the form. Whitespace-only edits do not count: tabbing through the fields is
  not work worth protecting.
- **Salary is kept as typed.** Splitting `$120k–150k, DOE` into a range with a
  currency and a period is parsing, and parsing belongs with the extraction
  adapters. A weaker version here would have left two of them to reconcile.
- **Only company and job title are required.** A job heard about by email is
  still worth tracking, and `findDuplicate` already declines to key on a URL that
  is not one.
- **The wipe is driven by a timer**, not `animationend`, which does not reliably
  fire for the zero-length animation that reduced motion turns this into.
- **The theme follows the OS.** One `prefers-color-scheme` block over a set of
  tokens, with no toggle and no stored preference — there is nothing to persist,
  and a setting would be a thing to migrate.

A read-only list of recent saves sits below the form, which is what makes the
phase gate checkable without opening devtools. The diagnostics that used to be
the whole panel fold into a `<details>`: still worth having, since a storage or
migration problem is otherwise invisible, but no longer the point.

**Done when** a job entered by hand survives a reload.

### What review changed

Recorded here because two of the five are the shapes named under "Recurring
shapes" below, which means those patterns predate phase 6 by three phases — they
were simply not being counted yet.

- **A claim that outran what was true.** The panel said "Nothing saved yet"
  alongside its own error banner, when all that had happened was that the list
  failed to load — a false statement about someone's records in the one place
  meant to reassure them the records are still there. `postings` became `null`
  until answered. Phase 7's dashboard has the identical fix, arrived at
  independently, as three read states rather than two.
- **A check-then-act spanning an await.** `toPostingInput` snapshotted the draft
  before the save round-trip, and on a cold worker that round-trip is not
  instant. A correction typed into the gap was checked against the old values,
  written as the old values, and then wiped by the reset. The fields lock while a
  save is in flight.
- A failing `storage/reassess` became a silent unhandled rejection that left the
  panel showing pre-persist state — the worker dying between the status reply and
  that call is ordinary for MV3 and the reason the client retries at all.
- Stale migration-flag recovery moved to the paths that do no work. Clearing it
  on entry released readers parked in `waitForMigration` moments before the same
  call raised it again and began rewriting records — the half-migrated read the
  flag exists to prevent (decision 9).
- `formatWhen` counted elapsed hours rather than calendar days, so something
  saved at 23:00 and read at 08:00 said "today".

## Phase 4 — extraction

Reading a posting off the page. Adapters are tiered, generic first, so a new
board is partly covered before anyone writes an adapter for it (decision 5).

- **Tiered adapters** — JSON-LD `JobPosting`, then embedded application state,
  then per-site DOM selectors, then OpenGraph and meta tags. Greenhouse and Lever
  first; Workday last, since it is a heavy SPA that fetches through internal
  JSON APIs and is several times the work of the others.

  That order is **not** the one this file originally gave, which ranked
  OpenGraph second. Both launch boards' real markup contradicted it: Lever's
  `og:title` welds the employer to the role, and Greenhouse's `og:description`
  holds the location. Meta tags are link-preview copy and belong last, where
  they still cover a site nobody has adapted. See decision 5.
- **Snapshots and adapter versioning** so a parser fix can be replayed against
  what the page actually said (decision 6). The stored snapshot is itself a
  parseable document, so a re-parse runs the same adapters as a live page.
- **URL reporting that survives SPA navigation.** The content script reports its
  own `location.href` rather than the extension reading `tab.url`, which keeps
  the manifest free of the `tabs` permission (decision 2). The trap: Workday and
  Ashby change the URL without a page load, so a script that reads the location
  once at injection goes quietly stale as the user clicks between postings.

  This file suggested patching `pushState`/`replaceState`. **That cannot work
  from a content script** — an isolated world has its own JavaScript heap, so the
  function patched is not the one the page calls. What ships is `popstate` and
  `hashchange`, the Navigation API's `navigatesuccess` where present, and a
  once-a-second poll of `location.href` as the backstop that makes the answer to
  "did it notice?" actually yes.
- **Fixture tests** against checked-in HTML, so a board changing its markup
  surfaces as a failing test rather than as silence. Both fixtures are real
  captures — a live Greenhouse posting and Lever's own public demo board — because
  markup this project invented could never notice a board changing.
- **The panel's fill affordance.** A banner naming what the page said and which
  fields it would fill, behind an explicit click. A pristine form fills straight
  away; a form with typed work in it asks first (decision 13).

**Done when** opening a real Greenhouse or Lever posting fills the form, and the
adapters still pass against saved fixtures.

### Deliberately not in phase 4

- **Auto-fill, tab following, and swap rules.** Filling is a button here. The
  panel re-reads the active tab on mount and on focus, and nothing listens to tab
  changes. That is phase 5, and keeping it there is what stops decision 13's
  rules from being half-built in two places.
- **Boards embedded in a company's own careers page.** The modern Greenhouse and
  Ashby embeds render into the host page on a domain the manifest has no business
  matching. Reaching them is what phase 5's click-initiated `activeTab` capture
  is for.
- **Salary written in prose.** Structured salary is read only where a board
  states it structurally. A wrong salary is a number that looks authoritative in
  a dashboard and is off by a factor of twelve; prose ranges are where every one
  of those mistakes lives.
- **The 500-posting snapshot retention sweep** from decision 6. Snapshots are
  one per posting and replaced on re-capture, so nothing grows without bound per
  record, but nothing prunes old ones either. It belongs with phase 6, where the
  storage picture is already open.
- **Ashby and Workday adapters.** Both are reachable today through the generic
  adapter's JSON-LD tier, and `atsReqId` already comes off their URLs from
  phase 2.

## Phase 5 — live sync and the revisit warning

The phase that makes the tracker a companion rather than a form. Everything here
depends on phase 4 producing a reliable URL.

- **Tab listeners and swap rules.** A pristine form auto-fills from the active
  tab; once anything has been typed, a new posting announces itself as a banner
  instead of overwriting the work (decision 13). The dirty tracking this needs
  already exists, and `isDirty` already compares against a baseline rather than
  against empty for exactly this reason.
- **The revisit warning.** On arriving at a posting, canonicalize the reported
  URL and run `findDuplicate` *before* anything is typed — "You tracked this on
  14 March — applied." This is the same machinery the save-time duplicate check
  uses; it just runs earlier, which is when the question is actually being
  asked. Answering it at save is answering it too late.
- **The toolbar badge.** `chrome.action.setBadgeText` marks the icon when the
  current page is already tracked, so the answer arrives without opening the
  panel at all. No extra permission — the action is already ours — and it only
  works on domains a content script matches, which is the honest limit of the
  narrow-permission posture. Likely the highest value-per-line feature in the
  plan: it answers "have I been here before" at the moment someone would think
  to ask.
- **`activeTab` capture for the long tail.** Unknown sites are reachable by an
  explicit click, which grants access to that one tab without a broad host
  permission (decision 2). Automatic detection is the deliberate trade-off given
  up here; a click is the price of not asking for every site.

**Done when** tabbing between postings moves the form correctly, typed work is
never clobbered, and returning to a posting already saved says so — in the panel
and on the badge — before a single field is touched.

**Shipped**, across two branches rather than one: `feat/live-sync` for the panel
and worker, `feat/activetab-capture` for the long tail, split so the half with
the most uncertainty in it could be read and reverted on its own. Three things
turned out differently from the plan above.

The capture gesture is **not a click in the panel**. `activeTab` is granted by
four gestures and a button inside an extension page is none of them, so the
feature is a context menu item and a keyboard shortcut, and the panel can only
point at them (decision 2). This was the phase's one genuine surprise.

The badge is **not limited to matched domains**. The bullet above assumed it
"only works on domains a content script matches"; it works anywhere a detection
exists, which now includes any page captured by gesture. The honest limit is
narrower than the plan expected.

A tab **forgetting its detection on navigation** was not in the plan and had to
be. Auto-fill is what makes it necessary: in phase 4 a stale detection meant a
banner offering a page the user had left, which could be ignored, and once the
form fills itself it means the previous job silently appearing on an unrelated
site (decision 15).

## Phase 6 — export and import

The backup phase. Decision 1 puts the data on exactly one device, which makes
the export file the whole of the backup and portability story rather than a
convenience feature.

- **JSON, in `lean` and `full` variants** (decision 14). `lean` is records only
  and is the one that can be shared or archived; `full` adds the trimmed page
  snapshots so a restored database can still be re-parsed after a future adapter
  fix. The variant is enforced when the bundle is built, not trusted from the
  caller — a `lean` file with snapshots in it would carry exactly the
  page-derived content the variant exists to leave behind.
- **Skip-duplicate import.** A record whose id is already stored is left exactly
  as it is, and the summary says how many were kept that way. Import is
  deliberately *not* `upsertPosting`: that path stamps `updatedAt` with the
  present, which is right for a save and wrong for a restore.
- **CSV as a one-way report.** UTF-8 BOM, CRLF, RFC 4180 quoting, and a
  formula-injection guard on every cell — every string in a record came off a
  web page, and a title beginning `=` is a formula the moment the file opens.
- **Erase everything**, behind a confirmation. It is in scope because a backup
  nobody has ever restored is a backup nobody can trust, and wiping is how a
  person finds out theirs is real.
- **The 500-snapshot retention sweep** from decision 6, deferred out of phase 4
  and built here where the storage picture was already open. Records are never
  dropped, only their snapshots.

**Done when** exporting, erasing and re-importing leaves the data identical.
There is a test that does exactly that, through the real message layer rather
than against the repository — the batching, the envelope and the validator are
half of what could go wrong.

**Shipped.** Four things are worth recording.

**Backup traffic is batched, and everything goes through the worker.** A `full`
export is records plus up to 500 pages of up to 256KB each, so handing it over
in one message would serialize tens of megabytes and hold them in two contexts
at once. Letting the panel open its own database connection for the read half
was the obvious alternative and was rejected: import is unambiguously a write
(decision 4), and a panel that opened the database would also be the context
performing Dexie's structural upgrade on the next release that adds an index.

**The importer has to migrate what it imports.** A backup restored after an
upgrade carries records written by whatever build the user had, and nothing else
would ever bring them forward — the migration harness keys off `dataVersion`,
which the worker brought up to date at startup, so from its point of view there
is nothing pending. This is decision 9's silent-loss shape arriving through the
one door that does not go past the version stamp. `migrateImportedRecords`
closes it. Unreachable today, since the exporter always writes at the current
version, which is precisely why it had to be built before it was needed.

**A restore must preserve timestamps.** Writing an import through the ordinary
save path would arrive with every record edited today, in one indistinguishable
block, and "newest first" would mean nothing ever after. It is the kind of loss
that leaves no trace to notice.

**CSV needed a security decision.** Formula injection is a real hazard here
rather than a theoretical one, because the strings in a record are chosen by
whoever wrote the job posting. The guard fires on ordinary text too — a note
beginning "- called back" gets an apostrophe — which is the right direction to
be wrong in for a report that is never parsed back.

### What review changed

Fifteen defects across two rounds, and the useful thing about them is that they
clustered. Almost none were in the storage layer; they were in **what the code
said about what it had done**.

- A count that promised more than the database held — pages inserted and swept
  by the retention cap in the same breath, reported as added.
- A summary that under-reported a partial import, because the refresh sat on the
  success path only, so four hundred records genuinely written showed as
  nothing.
- A destructive dialog that said "Erase 0 records" over a full database, because
  the count falls back to zero before the worker answers.
- A `lastBackupAt` asserting a file had been written when all that can be
  observed is that one was offered.
- Two checks that contradicted their own comments: `formatVersion !==` refusing
  older files the comment above it promised to accept, and a formula guard
  naming `\t` and `\r` where the docs claimed all leading whitespace.
- A uniqueness check that read before the loop, so it tested the batch against
  the past and not against itself.
- A migration that ran but recorded nothing, so an interrupted chain could never
  be resumed — a protection that executed without leaving evidence it had, which
  is decision 3's recurring pattern wearing a new face.
- Badges left asserting records a wipe had just deleted.

Worth carrying into phase 7: the dashboard is nothing *but* claims about the
record set, and every defect above was a claim that outran what was actually
true.

## Phase 7 — the dashboard

The phase that makes the saved data say something. Everything before it was
about getting records in and keeping them; this is the first that reads them
back for their own sake.

- **A full extension page, not a panel view.** The panel is ~360px and a status
  funnel, a twelve-column timeline and a per-board table do not fit in it. The
  panel links to a tab, and the link focuses the tab already open rather than
  opening another — which needs a tab id the dashboard registers about itself,
  because `tabs.query`'s `url` filter is silently ignored without the `tabs`
  permission the manifest does not have (decision 17).
- **`liveQuery` over a connection that declares no schema.** The roadmap table
  above says "`liveQuery`-backed views" and decision 14's amendment says the
  dashboard "will read directly", but that same amendment rejected a panel-side
  Dexie connection because whichever context declares a version is the one that
  performs Dexie's structural upgrade. Both hold at once: a `Dexie` constructed
  with no `version()` call opens in dynamic mode, adopting whatever is on disk,
  with no version of its own to upgrade *to*. The worker keeps sole possession
  of the schema and the dashboard still gets reactivity without polling
  (decision 4, amended).
- **Three views.** A status funnel over `viewed` / `applied`; tracking and
  applying over time in weekly or monthly buckets; and per-board yield, grouped
  by host so one board does not split across two rows.
- **The arithmetic is a separate, tested module.** `lib/dashboard/aggregate.ts`
  is pure functions and `Dashboard.tsx` renders what they return. This is the
  direct answer to what phase 6's review turned up: the dashboard is nothing but
  claims about the record set, so the claims are where the tests go.

**Done when** patterns are visible across saved data — and, specific to this
phase, when every record is either in a bucket somebody can see or in a residual
somebody is told about.

### The rule this phase is built on

Phase 6's fifteen defects clustered on statements that outran the truth, and a
dashboard is nothing else. So the aggregation obeys one rule everywhere:
**every record is either counted in a visible bucket or counted in a named
residual.**

Two residuals exist because two real cases need them, and both are ordinarily
zero:

- `appliedWithoutDate` — a record whose `state` is `applied` but whose
  `appliedAt` is null. `state` and the date are two different controls on the
  form, `PostingForm.tsx` already guards for the pair, and the importer accepts
  records written by any earlier build. Such a record is in the funnel's
  `applied` and cannot be placed on a timeline. Dropping it silently would make
  the chart disagree with the figures above it with no way to tell which lied.
- `beforeWindow` — records older than the oldest bucket shown. The window is
  capped so a two-year history does not render a hundred columns three pixels
  wide, and what the cap excludes is stated rather than discarded.

Two smaller applications of the same idea. Rates are `null` rather than `0` when
there is nothing to divide, because zero percent is a finding — it says you
applied to nothing — and an empty database has not earned the right to say it.
And the read path has three states rather than two: "still loading", "loaded and
empty" and "could not read" are three different statements about someone's
records, and only one of them should ever render as "nothing here yet".

### Deliberately not in phase 7

- **Editing from the dashboard.** It reads. Decision 4 forbids the write, and the
  panel is where a record is edited.

  > **Corrected in phase 8.** The second clause was not true when it was
  > written and is still not. The panel has no edit path either: `PostingForm`
  > always saves under a freshly generated id and never loads a stored record,
  > and `RecentPostings` is inert. Nothing in this extension can change a
  > posting after it is first saved. The sentence read as a statement of where
  > the capability lives; it was a statement of where it *would* live. See
  > phase 9.
- **Response and outcome tracking.** A funnel from `applied` to *heard back* is
  the obvious next view and there is nowhere to store the answer: the schema has
  two states (decision 8) and adding a third is a schema change with a migration,
  not a dashboard feature.
- **Salary distributions.** Structured salary is read only where a board states
  it structurally, so the field is null on most records and any chart over it
  would be a chart of the minority that happened to parse.

**Shipped.** Three things are worth recording.

**The contradiction was dissolved, not settled.** This file and decision 14
disagreed about phase 7 for the whole of phase 6 — the roadmap promised
`liveQuery` views reading directly, and the amendment that promised it had just
finished rejecting a panel-side connection for the export. Both turned out to be
right, because the objection was to *declaring a schema* and not to opening the
database. A `Dexie` built with no `version()` call opens in dynamic mode: it
adopts whatever is on disk and has no version of its own to upgrade *to*. Worth
recording as a method rather than as a fact about Dexie — the disagreement had
sat there for a phase because both sides read as flat contradictions, and neither
was.

Two things fell out of it that the plan had not anticipated, both now pinned by
tests because both would have failed silently on real data: a dynamic connection
**cannot create** the database, so the first open on a fresh profile has to ask
the worker to, and its tables are **untyped**, so there is exactly one cast at
the boundary.

**`tabs.query({ url })` fails by returning an empty array.** The obvious way to
find an already-open dashboard, and its `url` filter is ignored without the
`tabs` permission decision 2 keeps out of the manifest. Not a refusal, not an
error — an empty result, indistinguishable from "no dashboard open". The link
would have opened a new tab on every click, each holding its own `liveQuery`
over the whole record set. The page registers its own id instead (decision 17).

**No component in this project had ever been executed.** The suite included only
`src/**/*.test.ts`, which was a sound arrangement while the panel's logic lived
in tested `.ts` modules and the `.tsx` files were thin. The dashboard is a page
of branches — loading, failed, empty, populated — and three of the four are the
unhappy ones nobody sees while building. Vitest now includes `.tsx`, and the
first thing the new tests caught was a real defect (below).

### What review changed

Two defects, and the useful thing is that they were **the same defect**.

- The timeline's residual note was gated on `beforeWindow.tracked`, but
  `overTime` places `createdAt` and `appliedAt` independently, so the two counts
  diverge. A job saved today and applied to six months ago lands in
  `beforeWindow.applied` with `tracked` still at zero — the note vanished, and
  the funnel claimed an application the chart did not show. Back-filling an old
  application is all it takes. The aggregation was correct throughout; only the
  rendering gate was wrong, which is why the sums in `aggregate.test.ts` all
  balanced.
- The dashboard tab was registered only by the tab itself, in `main.tsx`, which
  runs after its bundle loads and React mounts. A second click before that read
  the same empty session storage as the first and opened another tab — the exact
  outcome decision 17 exists to prevent, reached by a route it had not
  considered.

Both are a **check-then-act spanning an await**, and so was the worst of phase
6's: a uniqueness check taken before the loop, which tested a batch against the
past rather than against itself. See "Recurring shapes" below.

Also worth noting about the first one: the tests missed it because the only
`beforeWindow` case in the suite had *both* timestamps outside the window, so a
non-zero `tracked` masked the asymmetric path. A fixture that exercises two
fields together will not catch a bug that needs them to disagree.

## Phase 8 — outcomes, and the one submission signal that is not a heuristic

The phase that was planned as one thing and turned out to be another. It is
worth recording why, because the finding outlives the feature.

### The premise did not survive decision 2

This file's phase 8 was `feat/submit-detect`, "submission heuristics behind a
prompt". Scoping it started from the obvious question — how reliable can the
heuristics be? — and never got there, because a prior question settles it.

Detecting a submission needs code running on the page **at the moment of
submission**. This extension has exactly two ways to get code onto a page: the
content script the manifest declares, and an `activeTab` injection granted by a
gesture. `activeTab` is revoked on navigation, and a submission usually *is* a
navigation; `injected.ts` is a one-shot reader besides. So Workday, iCIMS,
Ashby, SmartRecruiters, LinkedIn Easy Apply and every board embedded in a
company's own careers page are not *hard* to detect. They are **structurally
undetectable** without `<all_urls>`, which decision 2 exists to keep out of the
manifest.

That reframes the whole phase. It is not a heuristic-quality problem that better
parsing could improve — it is a permissions boundary, and the only way through
it is a trade decision 2 already refused.

**The value was also inverted.** Detection can only run on the two boards where
the flow already works best: the panel auto-fills, the revisit banner answers,
and the record is one click away. Decision 12 priced manual save at exactly that
one click. The long tail — where the user does the most work, right-clicking to
capture and then typing — gets nothing. A phase spending its whole budget where
it is least needed is a phase to rescope.

### What survived, and what replaced it

Two things.

**One signal that is not a heuristic.** A submitted Greenhouse application lands
on `job-boards.greenhouse.io/<token>/jobs/<id>/confirmation` — a real page load,
publicly indexed, carrying the job id, so it joins straight back to a stored
record by URL. The resident content script's `watchUrl` already sees every URL
change. `lib/confirmation.ts` is a URL match and nothing else: no submit-event
interception, no fetch watching, no MutationObserver on confirmation text.

A `submit` listener *would* work in the isolated world, and is worse: it fires
on **attempt**, so validation failures and network errors look identical to
success. The confirmation navigation only happens when the application actually
went in.

**Lever is deliberately absent**, and the reason is the interesting one. Its
apply form is a distinct URL (`/<company>/<id>/apply`), which is a fine *intent*
signal — but the page after a successful submission is an employer-configurable
"Application Success Page URL" that can redirect off-host entirely. There is no
stable shape to match, **by design**. Guessing at one would be decision 3's
recurring failure exactly: a mechanism recorded as working because its existence
was checked rather than its behaviour. `confirmation.test.ts` pins the absence,
so a later change that adds a guessed Lever pattern has to delete a test and
argue with the reason written beside it.

**The phase that signal was always the front end of.** Phase 7's "deliberately
not" named response and outcome tracking as the obvious next view and said why
it could not be one: "the schema has two states (decision 8) and adding a third
is a schema change with a migration, not a dashboard feature." That is the rest
of phase 8.

### Two axes, not a third state

`state` is unchanged. Decision 8's "`applied` is never inferred" is about *the
user's* action; an outcome is about *the employer's* response, and they are two
questions (decision 18).

- `stage` — `screening` | `interviewing` | `offer`, the **furthest** point
  reached, so it only moves forward.
- `outcome` — `rejected` | `withdrawn` | `accepted`, or `null` while still open.

The case that forces two fields is the commonest real result in a job search:
**rejected after two interviews**. A single ladder can say one of those. Such a
record would drop out of the interview count the moment the rejection arrived,
silently understating the interview rate — the "claim that outruns what is true"
shape this file has been counting since phase 3, arriving through a schema
decision rather than a rendering one.

**"No response" is deliberately not a value.** It is both fields `null`, and how
long it has been silent comes from `appliedAt`. A field the user must maintain
by hand to stay true will go stale, because nobody returns to a record to tick
"still no reply"; a value derived from time is always true. `silence()` is the
one view in the phase that needed no new field at all.

The combination that looks wrong and is not: **`rejected` with no stage.** That
is being turned down without ever reaching a screen, which is most rejections.
`resolveProgress` settles only the two combinations that genuinely cannot mean
anything — progress on a posting never applied to, and an offer accepted without
an offer — and leaves that one alone.

### Done when

The dashboard says what happened after you applied — and, specific to this
phase, when the response funnel's rows can only narrow, because each is a subset
of the one above it rather than a separate bucket that happens to be smaller.

**Shipped**, across two branches on phase 5's precedent — `feat/outcomes` for
the schema, form, dashboard and backup, `feat/submit-detect` for the half with
the uncertainty in it, so it could be read and reverted on its own.

Four things are worth recording.

**A nullable field still needs a migration.** Adding `stage` and `outcome` as
`| null` looks like it needs no backfill, and that is the trap: a record written
at version 2 reads back with the properties **absent**, and `undefined` is not
`null` anywhere it matters. The CSV writer prints the string, the export
validator sees a shape it does not recognise, and `resolveProgress` carries the
absence straight back into storage. The migration makes the whole table one
shape, which is the only state the readers were written against.

**No Dexie structural upgrade, and that was load-bearing.** Neither field is
indexed — the dashboard reads the whole table — so `db.ts` still declares
`version(1)` and phase 7's schema-less reader is untouched. That is now pinned
by a test living in `dashboard/db.test.ts` rather than beside `lib/db.ts`,
because the dashboard is what pays if it stops being true.

**`heardBack` asks the positive question.** It is written as "reached at least
the first stage" rather than `stage !== null`. Same answer on well-formed data;
safer on anything else, because a record somehow carrying `undefined` answers
false here where the negative test answers *true* and quietly inflates the one
rate the view exists to report. Wrong low is recoverable. Wrong high reads as
good news.

**The event union grew, and decision 16 called it.** That entry said the union
was built to grow but that "refresh everything" would stop being the panel's
right answer once events meant different things. The second member is exactly
that: a submission is a question about one record, and re-reading the active
tab's detection would neither ask it nor answer it. The panel now branches on
`type`.

### The limit this phase ships with

**`stage` and `outcome` can only be set when a posting is first saved.** Review
found it, and it is the most important thing on this page.

There is no edit path anywhere in the extension. `PostingForm` always saves
under a freshly generated id and never loads a stored record; `RecentPostings`
is inert; the dashboard reads only (decision 4). The only writes to an existing
record are the submission prompt, which touches `state` and `appliedAt`, and an
import. The duplicate prompt's "Save anyway" writes a *second* record.

So two fields designed to change over weeks can hold only what was true at the
moment of first save — which is almost always "nothing heard yet" and "still
open". **The response funnel will read `N still open` indefinitely**, and
re-entering a job to record its rejection double-counts it in `funnel.applied`
and `responseFunnel.applied`, deflating the very rates the section exists to
report.

This is written here rather than left implicit because the alternative is a
dashboard section that looks authoritative and is inert — which is this
project's oldest recurring failure wearing yet another face. Phase 8 is
therefore **not finished by its own standard** until phase 9 lands; what shipped
is the schema, the arithmetic and the surfaces, with the one interaction that
makes them mean anything still missing.

> **Closed by phase 9.** The edit path exists, and the paragraphs above are kept
> as written because the limit was real for the length of a phase and the
> reasoning is what produced the next one. The response funnel is no longer
> inert.

Two smaller gaps, recorded rather than fixed:

- **`waitForMigration` has never had a production caller.** Decision 9 says "the
  panel and dashboard wait on that flag"; neither does, and nothing else does
  either. It is what made the `outcomes` defect below reachable rather than
  latent. Decision 3 names this pattern — a protection recorded as established
  when only its declaration was checked — and this is its fourth appearance.

  > **Closed after phase 9, on its own branch, and not by waiting.** The panel
  > was never exposed: its every request goes through the worker's `ready()`,
  > which migrates before answering, so the guarantee was real and credited to
  > the wrong mechanism. The dashboard was exposed, because it asked the worker
  > for anything only when the database did not yet exist — the round-trip ran
  > on the first-ever open and never again. `openForReading` now sends `status`
  > unconditionally, which buys the creation *and* the migration in one message.
  > The general form is worth keeping: **a flag can only be observed, and
  > observation cannot cause the work** — a reader watching the flag on a
  > torn-down worker sees `false` and reads stale records with confidence. See
  > decision 9's final amendment.
  >
  > **And deleted in phase 11.** The function survived that fix, kept because
  > "a diagnostics surface is the obvious future caller". Phase 11 is that
  > surface, and it declined for the reason the paragraph above gives. The flag
  > stays — `migrations.ts` recognises its own interrupted run by it, and the
  > diagnostics report prints it, because a migration in progress explains a
  > record count that looks wrong. Only the helper that waited on it is gone.
- **The submission prompt needs the panel already open.** The worker broadcasts
  and `broadcast` swallows the rejection when nothing is listening, which is the
  ordinary case; nothing is persisted and the content script never retries. With
  the panel closed the feature silently does nothing.

### What review changed

Six defects across the two branches, and they sort into the two shapes this file
has been counting.

**A claim that outran what is true**, three times, all in the phase built to
resist them. `outcomes` and `silence` compared `outcome` against `null` while
reading through the dashboard's own connection — which opens the database
directly and does not wait on the worker's migration, so a record written before
version 3 arrives with the property *absent*. `undefined` is not `null`: nothing
landed in `open`, a phantom `undefined: NaN` key appeared, and the card read "Of
2 applications: 0 still open, 0 rejected, 0 withdrawn, 0 accepted" over two open
applications, while the "still waiting" line vanished entirely.

The useful part is not either fix. `heardBack` was deliberately hardened against
exactly this shape, and the two functions beside it were not — so the lesson is
that **the defence belongs everywhere the shape can reach, not on the function
where the argument was first made.** `resolveProgress` had the same hole, and
worse consequences: it would have written the absence back and let
`upsertPosting` stamp it `schemaVersion: 3`, putting the record permanently
beyond the backfill.

**A check-then-act spanning an await**, for the fourth phase running, in the
banner added by the phase whose own section describes the shape. `onConfirm`
cleared the prompt after an awaited write, discarding a *different* confirmation
that arrived in the gap. Dismissal also left no mark, so a reload of the
confirmation page re-raised a question the user had just answered — the
"unanswered question" state decision 13's amendment exists for, reached by a new
component that did not inherit `PostingForm`'s discipline. And the banner
carried `saving`/`failure` across postings for want of a `key`.

Also corrected: a comment claiming the repository nulls `appliedAt`. It does
not — `resolveProgress` governs `stage` and `outcome` only — and as written it
made a load-bearing fallback look redundant.

### Deliberately not in phase 8

- **Lever, and every board without a declared content script.** See above. This
  is a permissions boundary, and the honest thing is to state it rather than
  ship a detector that works on one board and is described as if it worked
  generally.
- **A prompt for a page with no record behind it.** If someone applied without
  ever saving the posting, the extension declines to manufacture one: a
  confirmation page carries no employer, title or description worth trusting,
  and a junk record to save one click is a bad trade for a tracker.
- **Writing without asking.** Decision 12's revisit condition asks for a
  detector precise enough that silent writes would not manufacture history. One
  URL match on one board is not that, and this phase does not argue otherwise.
- **Response detection from email.** That is decision 7's external tracker, and
  it is still early.

## Phase 9 — editing a saved record

The phase phase 8 was waiting on. Everything before it could get records in and
read them back; this is the first that can change one after it exists.

The work turned out to be almost entirely in the panel. `posting/get`,
`posting/upsert` and `posting/delete` were already live message types with tests
against them, `upsertPosting` was already keyed by a caller-supplied id and
already preserved `createdAt`, and `findDuplicate` already declined to match a
record against itself. **The storage and message layers needed no changes at
all** — which is decision 4 paying out four phases later, and worth recording
because it is the opposite of what a "we cannot edit anything" limit sounds like
it will cost.

- **`draftFromPosting`, the missing inverse.** `toPostingInput` had existed since
  phase 3 with nothing going the other way. The test that matters is a
  round-trip driven off `POSTING_INPUT_FIELDS`: open a record, touch nothing,
  save, and every caller-owned field must come back identical. Written against
  the list rather than as assertions, so a field added later joins the check by
  existing — a field this pair dropped silently would be a field the user loses
  by looking at it.
- **`isDirty`'s baseline, cashed in.** It has compared against a baseline rather
  than against empty since phase 3, for the auto-fill case that did not exist
  yet. A stored record is just another baseline, so "the user has changed
  something" became "differs from the record as stored" without touching the
  function.
- **A filter over the whole list, not a longer list.** Five recent rows answer
  "did that save work", which is what phase 3 needed. They cannot answer "where
  is the job I applied to last month", and that is the *only* question this phase
  exists to serve — the record whose rejection needs recording is by definition
  not a recent one. Plain case-insensitive substring over company and title;
  `normalizeCompany` exists to make join keys agree, not to second-guess a search
  box.
- **Delete, finally given a surface.** The message existed and had never had a
  caller. Two presses, and the worker repaints the tracked badges from inside
  the handler — phase 6's "badges left asserting records a wipe had just
  deleted" is the same defect one record at a time. See below: this is the one
  thing that shipped wrong and had to be found by using it.

### The two that would have destroyed data

Both are recorded because neither is visible from the feature description, and
both are about the id rather than about the fields.

**Editing had to suppress the swap rule.** A record just loaded equals its own
baseline, so it is *pristine* by every test decision 13 applies — and pristine is
the state that auto-fills. Left alone, tabbing to any posting would repopulate
the form from that page **while it still held the stored record's id**, and the
next save would write the other job over the record being edited. Not a lost
draft: a destroyed record, reached by exactly the "pristine is not empty"
subtlety the swap rule was written around. `swapAction` gained an `editing` flag
that returns `announce` — offer, never take, because re-reading a posting whose
description changed is a real thing to want and an explicit fill layers onto the
current draft.

**Provenance had to be carried forward.** The save path chose between a
detection's context and `MANUAL_SAVE`, and an edit is neither. Falling through to
`MANUAL_SAVE` would restamp a record `manual@1` the first time anybody corrected
a typo in it — taking with it the only thing that says which records a later
adapter fix should replay (decision 6), for exactly the records that have a
snapshot worth replaying. `editContextFor` mirrors `saveContextFor` line for
line, including the rule that a structured salary survives only while the text
still reads as it was stored.

### A third place the gap is not an await

The swap guard was written, tested as a pure function, and *still let the record
be overwritten* on the one path that mattered. The component test caught it.

The effect that loads a record and the effect that swaps in a detection run in
the **same commit**. On the pass where the record arrives, the swap effect reads
`edited` as it was rendered — `null` — not as the effect above it has just set
it. So a record opened while the active tab was itself a posting was filled over
before it had ever been seen, with the guard present and correct and looking at
stale state.

This is the "check-then-act spanning an await" shape with the await removed. The
gap is a render commit, and the lesson generalises the entry under "Recurring
shapes" below: **the thing to ask is not "is there an await here" but "what does
this read, and when was it true".** The fix is to guard on the prop — the request
— which is available on the same render, rather than on the state derived from
it.

### What using it changed

One defect, and it is the interesting kind: **the badge did not clear after a
delete.** Save a Greenhouse posting, delete it immediately, and the toolbar went
on saying `✓` until the page was reloaded — at which point it cleared, which is
what made the cause findable.

The panel *was* re-reading the active tab, and a comment beside that call said
so and claimed the badge as its reason. That claim was false. `detection/get` is
a pure cache read; nothing on the panel's side of the protocol reaches
`chrome.action` at all. The only thing that repaints a badge is a fresh
`detection/report` from a content script, and that means a page load. So the
panel was doing something real, being credited with something else, and the gap
between the two was invisible because both halves looked right on their own.

The repaint moved into the `posting/delete` handler, which is the one context
that both knows the record is gone and can reach the toolbar — the one-record
case of what `backup/wipe` has done since phase 6, calling the same
`repaintTrackedTabs`. Passing no `tracked` argument is the whole difference: a
wipe can assert `false` for every tab, whereas after one deletion each tab has
to be **asked again**, because the answer differs per tab. There is now a test
for each direction, including that an unrelated deletion leaves a still-valid
badge lit.

Worth recording for two reasons beyond the fix. First, it is decision 3's
recurring pattern — a mechanism recorded as working because its existence was
checked rather than its behaviour — arriving for the fifth time, and this time
inside a phase whose own notes had just finished describing that pattern.
Second, **no test would have caught it**, and not because of an oversight: every
test in this phase asserted against the database or the rendered panel, and the
badge is neither. It is a side effect in a third context. Nothing but running
the extension was going to find it, which is an argument for the walkthrough
rather than an argument for more tests.

### What review changed

Two defects, and they are **the same defect as the badge** — state that outlives
the thing it describes, in a panel that had just been given a way to make things
stop existing. Three instances now, all in one phase, all found after the code
was written and none by the tests written alongside it.

**The revisit banner outlived the record it named.** Delete a posting while
sitting on its own page and the banner returned — "You looked at this on
14 March", naming the record just deleted, with its dates. It is hidden while a
record is open for editing, which is exactly what made it look like it needed no
attention: `reset()` clears `edited` and the banner comes straight back. The
effect that owns `revisit` is keyed on the detection id, and deleting a record
does not change what the tab is showing, so it never re-runs.

This is the badge, one banner over. Worse, the comment written *while fixing the
badge* claimed `refreshDetection()` cleared this one — a false statement about a
mechanism, replacing a different false statement about the same mechanism, in
the same commit that was supposed to have learned the lesson. `detection/get`
reads a cache only a content script ever writes; nothing the panel does can
invalidate it.

**The submission prompt's guard was one-directional.** Phase 9 added a check
that refuses to raise a prompt for a record already open in the form, and wrote
a comment describing precisely what would go wrong if both owned the record at
once. It did not cover the other ordering — prompt first, then the user opens
that record — which is the likelier one, because the prompt names a company and
a title and nothing else, so clicking the row to see which record it means is
the obvious way to answer it. The draft seeds `viewed`, confirming writes
`applied`, and the next Save writes `viewed` and a null `appliedAt` back over
it. The user's own answer disappears, taking the date the response funnel is
anchored on. A guard that names its failure mode in a comment and then closes
one side of it is worth more than no guard and less than it looks.

The tests are the other half of the finding. `PostingForm.test.tsx` mounts the
form alone and *cannot* see either defect: one needs `App` to clear `editing` on
the way out, the other needs the prompt and the form on screen together. A first
attempt at the revisit test passed against the unfixed code, because a stubbed
`onStopEditing` let the form re-open the record it had just deleted. **Both
regression tests were then run against the reverted fix to prove they fail** —
which is the only thing that distinguishes a regression test from a comment.
`App.test.tsx` exists now, and the shared `chrome` stub grew `tabs`,
`getManifest` and a real `onMessage` listener set to allow it.

### Deliberately not in phase 9

- **Optimistic concurrency on an edit.** A record loaded, left open, and changed
  from elsewhere before the save will be overwritten by the stale copy. Doing it
  properly needs `updatedAt` through `PostingInput`, which the type deliberately
  omits so a caller cannot forge one. The one realistic collision is closed
  instead: a submission prompt for the record currently being edited is
  suppressed, because otherwise the prompt writes `applied` and the form writes
  its own stale `state` straight back over it. The rest needs a real user to
  leave the panel open across a change they made in another window.
- **Editing from the dashboard.** Decision 4 forbids it writing, and it cannot
  open the per-tab side panel programmatically. The panel is where a record is
  edited — which, since phase 7, is finally a true statement.
- **Bulk edits.** A list with checkboxes is a different feature and would need
  its own answer to what a partial failure means.

## Phase 10 — a submission that survives a closed panel

Phase 8 shipped the one submission signal that is not a heuristic, and then
dropped it in the ordinary case. `announceSubmission` broadcasts, `broadcast`
swallows the rejection when nothing is listening, and nothing is persisted or
retried. **The panel has to already be open**, and almost nobody has a side
panel open while they are filling in an application form. The feature works
exactly when it is least needed.

This is a variant of the shape this file keeps counting, one step further out: a
mechanism that was verified end to end *in a context where it works*, and whose
ordinary context was never the one under test. Every test of the prompt mounts
the panel first.

- **A durable pending queue.** `chrome.storage.local`, not `session`. The
  realistic sequence is applying to three jobs on a Friday evening and closing
  the laptop, which `session` throws away by definition. Keyed by posting id so
  a confirmation page reloaded twice is one question, not two, and capped so a
  loop somewhere cannot grow it without bound — the same reasoning as
  `MAX_CACHED_TABS`, in the store that is not cleared for us.
- **A TTL, and the reason it is not load-bearing.** Entries expire after 14
  days. The obvious argument for an expiry is that a stale "yes" would corrupt
  the date the response funnel is anchored on — and that argument is *wrong*,
  because it is being fixed at the source: see below. What the TTL is actually
  for is narrower and worth stating as itself. Beyond a couple of weeks the user
  cannot answer "did you apply to this" accurately, and a question that invites
  a guess is worse than no question. One constant, easy to move.
- **The confirmation's own timestamp, not the answer's.** `markApplied` stamps
  `appliedAt: Date.now()` — the moment the button is clicked. That is already
  slightly wrong today and becomes properly wrong the moment a prompt can be
  answered days later: the record would claim an application date of whenever
  the user next opened the panel. The pending entry carries the `confirmedAt`
  the worker recorded when it saw the confirmation page, and that is what lands
  on the record. This is what makes a durable prompt safe rather than merely
  possible, and it is the reason the TTL gets to be a usability number instead
  of a correctness one.
- **The event demoted to a signal.** `application/submitted` currently carries
  the `postingId` the panel renders from. Once the question is in a store, that
  payload is a second source of truth for something already written down, and
  the open-panel and closed-panel paths would be two code paths that must agree.
  The event becomes "pending changed, re-read it", which is the shape
  `detection/changed` has always had, and the panel gets **one** path: read the
  queue on mount, and read it again when told to. The `postingId` field is
  removed rather than left unused — a payload nothing reads is the same defect
  as a comment nothing checks.
- **Dismissal becomes durable, and the in-memory `answered` set goes.** Today a
  dismissal is a ref that lives as long as the panel, because that was the only
  place to put it. Retiring the entry in the store is strictly better and
  removes the state: decision 13's amendment wants an answered question to stay
  answered, and a set that dies with the panel only manages it until the panel
  is closed.

### The queue, and what skips versus what retires

Answering advances to the next entry — `SubmissionPrompt` is unchanged and shows
one record at a time, which keeps each answer a deliberate one.

The distinction that has to survive the rewrite is the one phase 9 found by
review: a record **open in the form** is skipped, not retired. Retiring it would
discard a real question because the user happened to look at the record; the
form and the prompt would both own it, and the form's stale `state: 'viewed'`
would win. Filtering the queue on `editingId` rather than marking anything means
the question comes back when editing stops, which is correct, and needs no
second piece of state to track it.

### Done when

Apply to a posting with the panel closed, open the panel, and the question is
waiting — with the date the confirmation page was seen, not the date it was
answered. Three of them queue and answer one at a time. A dismissal survives a
browser restart.

### What using it changed

**Nothing, and that is the first time.** The walkthrough confirmed the sequence
the phase exists for — apply with the panel shut, open it later, the question is
waiting — along with the confirmation's own date landing on the record, and a
decision staying made across a panel close. No defect came out of it.

Worth recording, because every phase since 6 has had one and phase 9's was found
*only* by running the extension. Two things are different here, and neither is
"more care was taken":

- **The risky surface was a store, not a side effect.** Phase 9's badge lived in
  the toolbar, which no test in this project can observe. This phase's state
  lives in `chrome.storage.local`, which the suite reads directly. The thing
  that made the previous defect untestable was its *location*, and this phase
  did not put anything there.
- **`App.test.tsx` already existed.** Phase 9 created it, under review, to catch
  a prompt and a form owning one record at once. That is exactly the file this
  phase's hardest cases needed, and it was written before the phase started.
  A test file created in response to one defect caught the class of it in the
  next phase, which is the argument for writing them at the level the defect
  actually lives at rather than the level the code is organised at.

The walkthrough covers every path this phase added, including the two that
needed a way to fake a submission before they could be reached at all: a queue of
several confirmations pending at once, and the reversal below — a prompt
returning after the record is opened for editing and closed again.

That those two were reachable by hand at all is the tooling's doing, and it is
worth recording that **the tooling found its own defect first**. The recipe as
first written said to add `/confirmation` "to the end" of the posting URL, and a
real Greenhouse URL ends in a `gh_src` tracking parameter — so following it
produced `?gh_src=abc/confirmation`, leaving the path untouched.
`confirmationTarget` reads `parsed.pathname` and correctly declined.

It failed in the worst possible way: Greenhouse ignored the mangled parameter and
served the same page without a 404, and the content script parsed it happily
under the new URL. Every observable signal said the mechanism had run. Only the
unobservable one disagreed, and the first conclusion drawn from it was that the
extension was broken.

The recipe had been checked against `/jobs/4021/confirmation` — a URL with no
query string, which is not the URL anybody has. That is the fourth shape below,
committed by the notes that had just finished describing it.

### The TTL caught a bad test before review did

Two tests seeded `confirmedAt` with epoch-era constants (`1_000`, and a fixed
calendar date). Against the real clock both were months past `PENDING_TTL_MS`,
so the store swept them and the prompt never rendered — the tests failed on
their first run, which is the only reason it was noticed.

The fixed date is the interesting one. It would have *passed* had it been chosen
a few months later, and then silently stopped testing anything as it aged past
the expiry. A fixture pinned to a wall-clock date, in a codebase with any
expiry in it, is a test with a shelf life. Both are relative to `now` now.

### What reversed from phase 9

Opening a record for editing now **skips** its question rather than retiring it,
so an unanswered question returns when the form lets go.

Phase 9 retired it, and gave a sound reason: re-showing meant rendering a
`Posting` captured before the user touched it, which the form may since have
saved as `applied`. That objection is gone rather than overruled —
`refreshPending` re-reads the record from the worker on every pass and retires
anything that now says `applied`, so what comes back is current or does not come
back. What remained was retiring a real question because the user clicked the row
to see which job it named, which is the obvious thing to do when a prompt names a
company and a title and nothing else.

The general form is worth keeping: **a guard written around a stale copy should
be revisited when the copy stops being stale.** The reason had outlived the
constraint that produced it by one phase.

### Deliberately not in phase 10

- **Retrying a dropped content-script report.** This phase persists the
  *question*, not the detection that produced it. If the content script never
  reported, there is nothing to persist and the page is gone.
- **A prompt for a page with no record behind it.** Unchanged from phase 8, and
  for the same reason: a confirmation page carries nothing worth making a record
  out of.
- **Boards other than Greenhouse.** Still a permissions boundary, still the
  honest thing to state rather than to work around.

## Phase 11 — diagnostics you can send

Decision 1 bought "does not collect user data" by giving up crash reporting and
usage analytics, and named exactly one mitigation for the bugs that would then
arrive blind: a copy-diagnostics action putting adapter versions, the failing
hostname and a redacted parse result on the clipboard. It has never been built,
and the decision says so — "not yet built and is not scheduled". This phase
schedules it.

There is already a `<details>` section in the panel called Diagnostics, added in
phase 3 when the panel was a probe readout and kept when it stopped being one. It
answers *is the extension working*: worker responding, schema version, storage
protection, posting count, and what the current tab looks like. That is a
different question from *why did it fail on this page*, and only the first has an
answer today.

**The page this exists for is the page that reports nothing.** `report()` in
`content/capture.ts` calls `extract`, tests `isWorthOffering`, and returns early
when it is false — no message, no cache entry, no `DetectionSummary`. So on a
page the adapters could not read, the worker holds nothing, and the panel's own
diagnostics row says `no posting detected`, which is the whole of what it knows.
The one input a report needs is discarded a context away from where the report
would be assembled.

This is the fourth recurring shape below, and the first time it has been caught
before the code was written rather than after: the state the user is in when the
feature fires is *standing on a page where extraction failed*, and every existing
test of the detection path asserts a successful parse.

- **A pull, not a push.** The alternative is to report failures automatically,
  which means a message from every non-posting page on a matched board — a
  board's own listing page, its search results — to populate a cache for a
  question nobody has asked yet. Instead the report is produced on request,
  reusing the `activeTab` + `chrome.scripting` path `injected.ts` already uses
  for manual capture. No new permission, nothing cached, nothing written, and it
  reaches sites with no content script at all, which is where a blind bug report
  actually comes from. It is decision 2's trade applied a second time and for
  the same reason.
- **It reads what the tiers returned, not whether the result was worth
  offering.** Same `extract` call, same adapters, same `mergeTiers`. The
  difference is only which question is asked of the result: `isWorthOffering`
  collapses it to a boolean and throws the rest away, and `provenance` —
  `Record<FieldName, Tier | null>`, already computed and already carried on
  every `DetectionReport` — is the thing worth sending. It says which tier
  answered which field and, more usefully, which fields nothing answered.
- **The payload is an allowlist, and it is rendered before it is copied.** This
  blob is the only egress path in the product, and the product's claim is that
  there is none. A denylist is the wrong shape: it fails open, on a codebase
  where the fields keep growing. The list of what goes in is data, in `lib/`,
  and every field on it is either a version string, a hostname, a tier name or a
  count. And it is shown in the panel first — asking someone to trust a
  clipboard they cannot read is not consent, it is a request for one.
- **The PII was already found once.** Decision 6's trimming amendment exists
  because a real Greenhouse capture carried a voluntary self-identification
  questionnaire — gender, race, veteran and disability status — prefilled from a
  logged-in session. That is the standard this payload is held to. No field
  values, no URL path or query, no snapshot source, and none of the user's own
  writing.

### The trigger cannot live in the panel, and the plan nearly put it there

Building it turned up a constraint this file had already written down twice.
`activeTab` is granted by four gestures — an action, a context menu item, a
`commands` shortcut, an omnibox suggestion — and **a button in the side panel is
not one of them**. `capture.ts` calls that "the single most important fact about
this feature". The extension holds no `host_permissions` at all (decision 2's
amendment: the allowlist is `content_scripts.matches`), so *every* page needs the
grant, including the three boards the manifest matches.

A "Diagnose this page" button in the panel therefore cannot read the page. The
working notes for this phase had one, and it was the same claim-that-outruns-the
-code shape as everything else in this list — written because it is the obvious
affordance, not because anything checked whether it could work.

What survives is better than what was planned, because the trigger already
exists. The user right-clicks **Read this page into JourneyTracker**, which is
already the gesture, already the grant, and already the moment they are asking a
question about this page. When the read succeeds the form fills, as now. When it
comes back with nothing, that is when a diagnostic is worth having, and it is
exactly the case the old code dropped on the floor. No second menu item, no
second gesture to teach, no new bundle.

The panel keeps the half it can do: rendering the report and copying it. Copying
needs no grant. So the split is that **reading the page is a gesture and reading
the report is a button**, which is the same boundary decision 2 has drawn since
phase 5.

### What comes out, and what a version of it is for

`source` and `adapterVersion` name the parser that ran. `provenance` and the
confidence score say what it managed. The hostname says where. The
`StatusReport` half — schema version against data version, eviction safety,
counts — says whether the report is even about a healthy install, which is the
first thing worth ruling out and currently takes a screenshot to establish.

The panel footer's hardcoded `Phase 10 · pending submissions` is folded in here.
A phase label edited by hand every phase is a claim that goes stale on its own,
and a version string belongs in the readout rather than in the chrome.

### Re-parse is retired, and what that leaves

Decision 6 justifies the snapshot store on one promise: a parser fix is followed
by a re-parse of history, and a generic capture is upgraded once a real adapter
exists. Nothing re-parses, and the message layer says so more plainly than the
prose does. Export reads snapshots in bulk, through `snapshot/ids` and
`snapshot/list`. The single-record read — `snapshot/get`, the exact shape a
re-parse of one posting would use — has **no sender outside its own tests**.

The promise is being withdrawn rather than kept. Every field a parser can get
wrong — `workMode`, `location`, `salary`, `jobTitle` — feeds nothing that is
reported: the dashboard's figures all derive from `state`, `appliedAt`, `stage`
and `outcome`, which are user-set and never parsed. So a parser bug cannot move
a number; it puts a wrong label on a record that phase 9 made editable, at a
volume of a few hundred. Against that, a re-parse has to decide what to do with
a field the user typed by hand, and the record carries provenance per *record*
and not per field — so it cannot tell. The repair mechanism would be more
dangerous than the damage.

What that leaves is a snapshot store whose stated purpose is gone: a debugging
aid and the `full` export payload, against a 256KB cap, a trimming policy, a
retention sweep, an exclusion from the lean export, and page-derived PII. That
is a real question and this phase does not answer it — it takes the measurement
the answer needs, by putting `navigator.storage.estimate()` into the status
report, so how much the store costs stops being a guess. See decision 6.

### The cleanup this phase has to settle

`waitForMigration` is kept in `settings.ts` explicitly because "a diagnostics
surface is the obvious future caller". This is that surface, so the phase either
wires it or deletes it, and the answer is to delete it. The comment already
concedes the argument: the worker's `await ready()` is cause where the flag is
observation, a reader watching it cannot make a torn-down worker migrate, and
would read `false` and trust stale data. A diagnostics panel that asks the
worker inherits the stronger guarantee. Keeping a function whose only stated
justification has arrived and declined it is the defect this file keeps counting.

`snapshot/get` goes with it, for the same reason arriving from the other side:
it is the single-posting read a re-parse would have used, it has no sender, and
retiring the re-parse is what settles that it never will. `snapshot/put`,
`snapshot/ids` and `snapshot/list` stay — the capture and the export need them.
A request kind nothing sends is a payload nothing reads, which phase 10 already
deleted an example of.

### Done when

On a page the extension cannot parse — a Workday posting, a company careers
page, a board with no adapter — one gesture produces a report naming the host,
the adapter that ran and what each tier returned; the report is visible in the
panel before it is copied; and the pasted text contains no company, no job
title, and no URL path. The same gesture on a working Greenhouse posting reports
which tier answered which field.

### What building it changed

Two things the plan asserted turned out to be impossible, and both were written
because they sound like things that are true.

**The trigger could not live in the panel** — recorded above, where it belongs
with the design it changed. It is the larger of the two and it made the phase
smaller.

**`UnreachableReason` lost two of its three values.** The first draft had
`restricted-page` and `no-response`, for a `chrome://` tab that refuses
injection and an injection that never answered. Neither is reachable: the panel
does not trigger reads, so it never learns one was refused, and the worker
cannot supply the URL and adapter a report needs because it has no `tabs`
permission. What survived is `not-read`, which is the ordinary state of most
tabs. Writing an enum by imagining the failures rather than tracing them is the
same habit as the panel button, at a smaller scale.

The panel also forced a change back into the payload builder. `PageParse` took
an `Extraction`, and the panel holds whole `DetectionSummary` objects — so the
builder was being handed the very field values it exists to withhold, and the
allowlist was the only thing between them and the clipboard. It takes a
`ParsedPage` now, which has no `fields` at all. **An allowlist applied after the
values arrive can be got wrong; a parameter that cannot carry them cannot.**

### What using it changed

The walkthrough found no defect in the phase, and one elsewhere that matters
more than anything the phase shipped: the `applyFill` data-loss bug under
**Known bugs** at the top of this file. It is phase 9's, not this phase's, and it
was reachable the whole time — tabbing to a board while editing a record is not
an exotic sequence.

The observation worth keeping is *why* it surfaced now. Phase 11's walkthrough
instructions said to go and stand on pages the extension handles badly, which is
not what any previous walkthrough asked for. Every earlier one exercised the
feature just built, along its intended path. This one sent someone looking for
the seams, and the first thing it turned up was in code three phases old.

The other note from use: **it was hard to find a posting that yielded nothing at
all.** The tiered design does more work than expected on sites nobody wrote an
adapter for — JSON-LD and OpenGraph are close to universal on job pages, because
boards want to appear in Google Jobs and in link previews. That is decision 5's
payoff arriving as a mild inconvenience to testing, which is the right direction
for it to arrive from, and it means the `not-read` and partial-coverage rows are
the ones users will actually see.

### What review changed

Seven findings, all confirmed. Three were real bugs, and **two of the three had a
passing test sitting beside them** — which is the part worth recording.

- **A page that could not be *delivered* was reported as a page that gave up
  nothing.** `runLadder` resolves false both when no rung found anything and
  when every rung threw, and a torn-down MV3 worker makes the second ordinary.
  The diagnostic would have carried a full provenance set and printed `offered
  yes` in the same breath as the panel saying the page was unreadable. The test
  next to it asserted that a failed send does not break the page — true, and
  silent about what was then claimed.
- **A tab holding only a diagnostic navigated away without telling the panel.**
  `forgetTab` cleared it but returned whether a *detection* had been dropped, and
  the broadcast is gated on that answer. The panel went on offering to copy a
  report naming a site the user had left. The comment added with the fix — "it
  does not affect the answer below" — was true of the badge and false of the
  broadcast, in a sentence written while looking at both.
- **The report could describe a page the user was not on.** `panelReport`
  preferred the detection unconditionally, which is right only while both entries
  describe the same page. Ashby navigates without a page load, so `forgetTab`
  never runs and a detection for posting A survives a right-click on posting B.
  The URLs decide it now; when they disagree the newer wins, because the panel
  cannot ask which page it is on.

And four smaller ones, three of which are the same shape as each other: a
docblock asserting more than the code did. `ParseFacts` claimed a non-null field
and a non-null tier are the same condition — true inside `mergeTiers`, and
`sanitizeReport` was quietly breaking it by nulling over-length values while
leaving the tier alone. `ReportToSend` claimed to render "whether or not
anything is wrong" while being gated on a successful `status` round trip, making
the most report-worthy state the only one that could produce no report. And
`setup.ts` claimed several modules watch `chrome.storage.onChanged` when nothing
had since `waitForMigration` was deleted — a comment rewritten *during this
phase* to replace one false claim with another.

The fourth was the report text churning on every window focus, because the memo
was keyed on object identity and `refreshDetection` always sets a fresh
`detection`. It bites in the one flow that asks the user to touch the text:
clicking into the panel to select it, as the clipboard-refused message
instructs, wiped the selection and the message together.

**The regression tests for that last one were vacuous when first written**, and
were only caught because they were run against the unfixed code before being
trusted. With no detection seeded, every focus refresh resolves `null`,
`setDetection(null)` is a no-op React bails out of, and no identity ever changes
— so the tests passed on the broken version. The same check had been run
deliberately on the redaction tests in the first commit of this phase and skipped
here. It found a hole both times it was run, which is the whole argument for
making it a habit rather than a flourish: **a test written for a defect is not a
regression test until it has failed against that defect.**

### Deliberately not in phase 11

- **Automatic failure reporting.** Even locally. A cache of every page the
  adapters declined is a log of browsing on a matched board, kept for a question
  that is usually never asked. The gesture is the feature, not a limitation of
  it.
- **Sending anything anywhere.** The clipboard is the whole of the egress, and
  it is the user's clipboard. Decision 1 stands; a "report a bug" button that
  opened a pre-filled issue would be a network call in everything but name.
- **Re-parsing snapshots.** Retired above rather than deferred. If this ever
  comes back it needs per-field provenance and a schema change, and it should
  arrive with a defect that actually cost something.
- **Deleting the snapshot store.** Measured here, decided later. The `full`
  export depends on it and that is a user-facing feature, not an internal one.

## Phase 12 — the fill that means two things, and a fourth board

Two pieces of work that share a branch point and nothing else. The first is the
data-loss bug under **Known bugs**, which has been reachable since phase 9. The
second is the next adapter, which is additive and needs no new mechanism — the
same shape as the Ashby branch, which is why that one was not a phase either.

The bug goes first, and alone if the phase has to be cut. It destroys records.

### What the fill should do, which is the part that needed deciding

The bug entry above stops short of a fix on purpose: `applyFill` has to let go of
the record, but *letting go* is only one of two defensible answers, and the file
says so — "filling from a page while editing might reasonably mean 'update this
record from this page' rather than 'start a new one', and those want different
ids."

**Both readings are real, so the panel asks rather than picks.** While a record
is open for editing, `DetectedNotice` offers two actions instead of one:

- **Update this record** — keeps `draftId`, keeps `edited`, layers the page over
  the current draft. This is the case `fill.ts` already argued for in
  `swapAction`'s comment: "Re-reading a posting whose description changed is a
  real thing to want."
- **Save as a new record** — releases the record before filling, so `draftId` is
  fresh, `edited` is `null`, the duplicate check is re-armed, and the stored
  record is untouched.

The rejected alternative worth recording is **inferring it from a match** — run
the page through `findDuplicate`'s join keys, treat a hit as "update" and a miss
as "new". It is more elegant and it fails in the direction that costs a record:
a canonical URL that moved, a req id the adapter missed, and a silent inference
picks "new" when the user meant "update" — or worse, the reverse. Decision 13's
rule is that the form never overwrites the user's own work without being told
to, and an inference is not being told. The two buttons cost one click in a
sequence that is already deliberate.

That the buttons are *in the notice* also fixes the thing that made the bug
invisible: today the panel gives no sign, while a record is open, that "Fill from
this page" is about to write to it. The notice names the record it would
overwrite.

- **`applyFill` gains the exit `reset` owns.** Not by calling `reset` — that
  wipes the draft, and the new-record path has to keep the fill it just applied.
  The id-releasing half (`setDraftId(newId())`, `setEdited(null)`,
  `onStopEditing()`) becomes its own function that both call, so there is still
  one place where the id stops being the stored record's, and `reset`'s comment
  stays true.
- **`onStopEditing` has to fire on the new-record path**, or the panel hands the
  same record straight back through the `editing` effect and the form reopens
  what the user just walked away from. Phase 9's review found this exact
  interaction once already, in the delete path.
- **Provenance follows the id.** Update keeps `edited`, so `editContextFor`
  still answers for a record whose fill was refused, and `saveContextFor` wins
  when a fill lands — which is right in both branches, since the page was read in
  both. The bug's second symptom, a record stamped as captured off a board it
  never came from, goes away with the id.
- **The duplicate check stops being disabled by accident.** `if (!force &&
  !edited)` is correct on its own terms: an edit writes to a known id and cannot
  create a second record. It only misfired because `edited` outlived the edit.
  No change here — this is what the fix restores rather than what it touches.

### The guard audit this bug is an argument for

This bug is the fifth shape in **Recurring shapes** below, already written up
there with its check: for each guard, list the callers that reach the guarded
state *without* passing through it. What that entry adds to the fix above is
the reason `applyFill` is the right place for the release — "prefer guarding the
*destination* over the routes … it is the one place all the fills meet." The
check is cheap enough to run deliberately here rather than waiting for review to
find the next instance.

Kept to guards that stand between the user and a destroyed or wrong record:
`swapAction`'s `editing` branch (the one that failed), the duplicate check's
`!edited`, the `busy` locks on the fieldset and the notice, the pending queue's
skip-a-record-open-for-editing rule, and `onStopEditing`. Anything found is a
finding, not automatically a fix — some other path may be legitimately open, and
saying so in a comment is the outcome for those.

**The sweep found two, and the first is the same defect one layer up.**

- **The pending queue's skip was reading the request, not the record.**
  `refreshPending` suppresses a submission prompt for a record the form has
  loaded, because confirming it writes `applied` behind a form whose next Save
  puts `viewed` and a null `appliedAt` back over it — the comment on the skip
  says exactly this. It tested `editing`, which is the record the panel *asked*
  for, and the form is allowed to refuse. Open a record, then click a different
  row: the request names the second, the form goes on holding the first, and the
  prompt for the first came back up while it was still open. A guard tested
  against a proxy for the state it guards, which is the fifth shape again, with
  the proxy agreeing with the state everywhere except the one route that matters.

  The form now reports what it holds — `onHolding`, called where a record is
  taken and where it is let go — and the queue reads that. It is deliberately
  *not* the same signal as `onStopEditing`: "Keep what I have" settles the
  request while the form goes on holding what it already had, so collapsing the
  two would have that click report an empty form and rebuild the defect.

- **The `busy` lock missed the question raised between the two places that
  have it.** The fieldset has it, the detected notice has it and its comment
  generalises — "every way into the form has to be shut while a save is in
  flight, not just the inputs" — and "Open a different posting? / Open it" sat
  between them with neither. It replaces the draft and the id behind a save that
  has already snapshotted both, and the reset that follows wipes the record just
  opened. No record is corrupted; the click is swallowed with no sign it was
  taken. One `disabled={busy}` on each button, which is the rule the two
  neighbours were already following.

Both were proven the phase's way: written as tests, run against the unfixed
code, seen to fail, and seen to fail alone.

### Workday, and the permission question it raises

The first board whose host is **per-tenant**: `acme.wd1.myworkdayjobs.com`,
`acme.wd5.myworkdayjobs.com`, with the numbered data-center segment varying too.
Every previous board sat on one fixed host, so the manifest listed it and that
was the end of it.

This paragraph first said the phase "needs `https://*.myworkdayjobs.com/*`", that
this was "decision 2's territory", and moved on. **`manifest.test.ts` already
forbids it**, in a test written so that "a fourth board added later cannot
quietly reintroduce it" — and the fourth board added later is this one. The rule
came from `https://*.greenhouse.io/*`, which covered `app.greenhouse.io`, the
logged-in recruiter console. Naming a rule as territory and then walking across
it is not stating a constraint; the tripwire is what stated it.

Workday is genuinely unlike the case that motivated the rule: the tenant *is*
the subdomain, so the wildcard buys every employer where Greenhouse's bought
nothing but the recruiter console. That earns an amendment to decision 2, not a
rewrite of the test to let this through — and the amendment has to answer the
thing the Greenhouse case was about, which is what else lives under the pattern.

Under `myworkdayjobs.com` that is **the application flow**: the seven steps of a
Workday application, including `My Information` and the voluntary
self-identification questionnaire — the exact category of data decision 6's
trimming amendment exists for. `snapshot.ts` already drops `form`, `input`,
`textarea`, `select` and every inline script that is not JSON-LD, so a snapshot
of such a page carries far less than it looks. What it does not cover is
Workday's **Review** step, which renders what the user typed as ordinary text
outside any form element.

So the match is a wildcard **with `exclude_matches` for the application paths**:
automatic detection on postings, and a content script that structurally cannot
run where the user's own data is, rather than one that runs there and is trusted
to drop the right nodes afterwards. `manifest.test.ts` changes from "no wildcard
subdomain" to a rule that permits one only alongside exclusions, so the property
it defends survives in a stronger form than a ban that a fifth board would have
to argue with again. The `activeTab` path stays the fallback for tenants on a
vanity domain, which no allowlist could reach.

Two things are already built and tested, which is most of why this is additive:

- **`atsReqId`** — `normalize/ats.ts` already returns `workday` and parses
  `…/job/SF/Engineer_R-12345`, including the cases that are *not* requisitions
  (a title with an underscore, a title ending in a year).
- **URL canonicalization** — `normalize/url.test.ts` already holds two Workday
  requisitions that must not collapse into each other.

So the work is the adapter, its fixture, and its rung order. Workday renders
client-side like Ashby, so the expectation is JSON-LD where the tenant enabled
it, the embedded state blob where it did not, and no selector tier — for Ashby's
reason, that hashed class names are not site knowledge, they are this week's
build. **What the tiers actually return is a question for the fixture, not for
this file**: phase 11's lesson was that an enum written by imagining the failures
loses two of its three values. Capture a real posting first, then write the
adapter against it.

### What the first real Workday page changed

A diagnostic pulled from a live tenant — `premera.wd5.myworkdayjobs.com`, phase
11's gesture doing exactly the job it was built for — answered the question
above before any adapter was written, and reordered the rest of this section.

```
adapter    generic@1        company    jsonld
coverage   0.79             jobTitle   jsonld
offered    yes              location   jsonld
                            workMode / atsReqId / salary   not found
```

**Workday already works, with no adapter at all.** `generic@1` reads company,
title and location off schema.org JSON-LD and the result clears
`isWorthOffering`. That is phase 11's observation arriving a second time and
harder: it is difficult to find a posting that yields nothing, because boards
want to appear in Google Jobs. Decision 5's tier order is the reason, and this is
the second phase to be made smaller by it.

**`atsReqId not found` costs nothing.** It describes the extraction tiers, not
the record. `deriveJoinKeys` falls back to `extractAtsReqId(url)`, whose Workday
cases were already written and passing, so a saved record carries `R-12345`
whether or not a tier read it. The diagnostic's row is honest about what it
measures and easy to misread as a gap — worth knowing before it is treated as
one.

So the adapter is no longer what makes Workday work; it is what would add
`workMode` and `salary` to a page that already gives up four fields of six. The
manifest is what makes any of it automatic — the diagnostic above required a
deliberate keystroke, because no content script matches the host — and it is
therefore the high-value half and the one with a permissions question attached.

Salary is the more interesting of the two missing fields: the tenant probed is a
Washington employer, and Washington requires a pay range in the posting. If the
range is on the page but not in `baseSalary`, the fixture will say where — and
that is a question for the fixture, not for this file.

The submission-confirmation path (decision 12) is **not** extended to Workday
here. Greenhouse's detection works because its confirmation is a URL; whether
Workday has an equivalent is unknown, and inventing one is how a heuristic gets
in.

### Done when

Open a saved record, tab to a different posting, and the notice names the record
it would overwrite and offers both answers; "Save as a new record" leaves the
original exactly as it was; "Update this record" writes to it and to nothing
else. Each regression test has been **run against the unfixed code and seen to
fail** — phase 11's rule, which caught a vacuous test the one time it was
skipped. And a real posting on a `*.myworkdayjobs.com` tenant fills the form,
with the diagnostics report from phase 11 as the tool for reading the ones that
do not.

### What building it changed

**The phase had its two halves in the wrong order**, and one diagnostic from a
live tenant said so — recorded above, where it belongs with the plan it
reversed. The adapter was assumed to be what made Workday work; `generic@1`
already did, and the manifest was the half with all the value and all the risk
in it.

**The wildcard met a test written to stop it, and the test was right to.** Also
above. What is worth adding here is that the fix was not to weaken the rule:
`manifest.test.ts` went from banning a wildcard host to requiring that one be
named in the exclusions, which is a *stronger* rule and one a fifth board will
not have to argue with.

**`exclude_matches` turned out to be half a guard.** It is evaluated at
injection, and the ordinary route into a Workday application is a same-document
navigation from the posting — the script is already running and nothing
re-evaluates the manifest. That is the fifth recurring shape for the third time
in one phase, and the third time the answer was to guard the destination:
`capture` refuses before the document is parsed, and the manifest handles the
cold load it can actually see.

**Two real URLs contradicted two rules written without any.** `WORKDAY_REQ` had
been built from invented URLs and matched none of the real ones; then the
requisition it produced disagreed with the one in the page's own JSON-LD, which
reversed a decision made two commits earlier about keeping the repost counter.
Both were quiet failures — an empty column and a mismatched key, nothing that
throws.

### What using it changed

The walkthrough passed on the fill notice, the flow exclusions and the three
untouched boards. It also found the one defect in the phase that the entire
suite was blind to, and the reason it was blind is the part worth keeping.

**The work mode read `null` on every real posting.** The adapter passed the
description through `cleanText`, which rejects anything over 300 characters —
right for a field value, where a string that long means a selector matched a
container, and wrong for a description, which is the haystack and not the value.

**The fixture is what hid it.** It had been trimmed to the description's first
line and a sentence about pay, which left it just under the cap, so `cleanText`
returned a usable string and every test passed against a document whose
defining property had been removed. The fixtures are checked in because invented
markup can never notice a real board changing; this is the same rule's other
edge, and it is now a sixth shape below.

The repair was to keep the JSON-LD verbatim and to assert the *property* rather
than the behaviour — one test fails if the description is not longer than
`MAX_FIELD_LENGTH`, so a retrim cannot quietly restore what the bug needs. The
anchoring test improved by the same move: the real description says "on-site"
three times past the four-thousandth character, about the employer's offices
rather than this job, where the invented one had a trap written to be caught by
the code that had just been written.

### Deliberately not in phase 12

- **Prose salary.** Premera states a range, as Washington requires, in the
  middle of the description. `salary.ts` reads `baseSalary` and nothing else on
  the argument that a missed salary costs a copy-paste while a wrong one is
  authoritative and off by a factor of twelve, and that argument is not weaker
  on Workday. The fixture keeps the real phrasing so that reopening this has
  something to work against.
- **Extending the flow refusal to Lever.** Its apply form is
  `/<company>/<id>/apply` and the privacy argument carries; so does the cost,
  which is that a refused read means the panel forgets the posting while the
  user is applying to it. A decision to take for Lever, not to inherit from a
  pattern written for Workday.
- **Inferring update-or-new from a match.** Rejected above, not deferred.
- **Workday submission detection.** No signal is known to exist; decision 12's
  bar is a confirmation that is not a heuristic.
- **iCIMS and SmartRecruiters.** One new board at a time, so that what the
  Workday fixture teaches about per-tenant hosts is known before the next one
  commits to a pattern.

## Recurring shapes

Two shapes account for most of what review has found, across every phase that
has had a UI. Both are about the gap between what code does and what it says it
did, and both are cheap to look for deliberately.

They were noticed in phase 7 and written down then, which is later than they
started. Writing phase 3's section afterwards turned up both of them in *its*
review as well — so the count below begins at phase 3, not at phase 6 where they
were first named. That is itself the useful part: they had been recurring for
four phases before anyone was counting.

**A claim that outruns what is true.** Phase 3: "Nothing saved yet" shown
alongside the panel's own error banner, when the list had merely failed to load.
Phase 6 found nine — a count of pages inserted and swept in the same breath
reported as added, a summary that under-reported a partial import, a dialog
offering to erase zero records over a full database, a `lastBackupAt` asserting
a file had been written when all that can be observed is that one was offered.
Phase 7 was built specifically to resist them, said so in three places, and
still shipped one: a residual that hid itself when only half of it was non-zero.

The check: for every number or status rendered, ask what makes it true, and
whether it is still true when the thing it describes is zero, partial, absent,
or split across two fields that move independently.

**A check-then-act spanning an await.** Phase 3: `toPostingInput` snapshotted
the draft before the save round-trip, so a correction typed into the gap was
checked against the old values and written as the old values. Phase 6: a
uniqueness check that read before the loop, so it tested the batch against the
past and not against itself. Phase 7: a tab lookup that read before a create, so
a second click read the same empty storage as the first. In all three the read
and the act were individually correct and the gap between them was not held.

The check: wherever an `await` sits between deciding and doing, ask what else
could run in the gap — and note that in an extension the answer is rarely
another thread. It is usually the same person clicking twice, or a service
worker dying mid-conversation.

Phase 9 widened this one. Its instance had **no await at all**: two effects in
the same render commit, where the second read state the first had just set and
saw the previous value. The guard was present, correct, and unit-tested, and the
record was overwritten anyway. So the check is better asked without mentioning
awaits — **for every value a decision reads, ask when it was last true** — and
the await is merely the most common way for the answer to be "before this
started".

**A third shape, and phase 9 found it three times: state that outlives what it
describes.** The badge, the revisit banner and the submission prompt are all
claims about a record, all held in a context that does not learn when the record
changes. Deleting is what exposed it, because before phase 9 nothing could make
a record stop existing while something was still pointing at it. Each was
individually invisible: the badge lives in the toolbar, the banner is hidden
behind the very mode that deletes, and the prompt only collides when two
surfaces are on screen together.

The check: **for every surface that names a record, ask what tells it the record
is gone.** If the answer is "a re-read that happens to run", it does not — a
cache read returning the same value re-runs nothing, and an effect keyed on
something that did not change does not fire. The invalidation belongs wherever
the record is destroyed, not wherever it is displayed.

**A fourth, and phase 10 was built entirely to fix one instance of it: a
mechanism verified in the context where it works, whose ordinary context was
never the one under test.** Phase 8's submission prompt was correct, tested end
to end, and did nothing at all in practice, because every test of it mounted the
panel first and the real user has the panel closed. Nothing was broken; the
tested case was simply the rare one.

It is the "declared rather than executed" pattern of decision 3 with the
declaration *true* — the code runs, it is just never reached the way it is
actually used. That makes it harder to find than the others, because a grep for
the caller succeeds.

The check: **for every feature, name the state the user is in when it fires, and
ask whether any test puts them in it.** Not "is this covered" — coverage was
never the problem — but "is the covered case the common one". Where a feature
exists to catch someone at a moment they are doing something else, the answer is
usually no, and the test that would have caught it is the one that sets up the
inconvenient state first.

**A fifth, found by phase 11's walkthrough in phase 9's code: a guard placed on
one path to a hazard, where another path to the same hazard is one the design
deliberately kept open.** `swapAction` refuses to let a detection auto-fill a
form that is holding a stored record, and its comment states the consequence
exactly — "the next save would write that other job over the record being
edited. Not a lost draft: a destroyed record." Having named it, the same function
returns `announce` rather than `nothing` so the banner survives, under "Offer,
never take." The offer, when taken, takes: the manual fill runs `applyFill`,
which never clears the record's id. See **Known bugs**.

This is the hardest of the five to see, because everything about it looks
right. The hazard is identified, the reasoning is written down, the guard is
correct, and a test covers it. What is missing is a second guard on a route the
same paragraph goes on to describe.

The check: **for every guard, ask which callers reach the guarded state without
passing through it.** Where the guard's own comment explains why a hazard is
dangerous, read the next sentence — if it describes a way the user can still get
there, that is the missing case. And prefer guarding the *destination* over the
routes: `applyFill` is where the id should have been let go, because it is the
one place all the fills meet.

Phase 12 hit this shape **three times in one phase**, which is what promoted it
from an observation to something worth checking deliberately: the fill that kept
the record's id, the pending-queue skip that read the panel's request instead of
what the form held, and `exclude_matches` guarding the injection while the
same-document navigation walked past it. All three were guards that were correct
about the route they were written for.

**A sixth, and the fixtures' own rule turned inside out: a real capture trimmed
until it no longer represents the page.** The fixtures are checked in because
markup this project invented could never notice a board changing its own — and
the same argument says nothing about markup the project *trimmed*. Phase 12's
Workday adapter read the description through `cleanText`, which rejects anything
over 300 characters; every real posting therefore returned `null` and lost the
work mode silently. The fixture had been cut to the description's first line and
a sentence about pay, landing just under the cap, so the whole suite passed
against a document whose defining property had been removed. The bug was found
by loading a posting in Chrome, which is the only thing that was still looking at
the real page.

This one is nastier than a fixture that is merely stale, because a trimmed
capture *is* real markup and reads as trustworthy — the header at the top of it
even says what was cut. What it does not say is what the cut was load-bearing
for, because whoever cut it did not know.

The check: **when trimming a capture, ask what property of the original each cut
removes, not just what content.** Length, ordering, and the presence of a second
block that a greedy pattern would run past are all things a page has and a
tidied excerpt does not. Where a property is load-bearing, assert it in a test
so the retrim fails loudly — `adapters.test.ts` now requires the Workday
description to be longer than `MAX_FIELD_LENGTH`, which is a strange-looking
assertion that exists precisely because its absence was invisible.

## Changes from the original plan

- **Records moved from `chrome.storage.local` to IndexedDB** (decision 3). The
  earlier roadmap had records in `chrome.storage.local`, which contradicted the
  decisions doc; snapshots are what force the change.
- **The resume library is cut** (decision 11). Was phase 3; `resumeUsed` is now a
  label captured on the form in phase 3.
- **Phase 1 split in two** — schema/storage, then normalization/join keys — because
  the decisions doc added migrations, the message layer, persistence and real
  normalization to what had been one phase.
- **Snapshots and adapter versioning added** to phase 4 (decision 6).
- **`activeTab` capture path added** to phase 5 (decision 2), so unknown sites are
  reachable by an explicit click without a broad host permission.
- **Export gained lean/full variants** (decisions 6, 14), so a backup can be shared
  without the page-derived PII snapshots carry.
- **The extraction tier order is JSON-LD → app state → DOM → OpenGraph**
  (decision 5), not the JSON-LD → OpenGraph → app state → DOM this file first
  gave. Meta tags are link-preview copy, and both launch boards prove it.
- **Greenhouse emits no JSON-LD** (decision 5). The tier is still first where it
  exists, but "JSON-LD first" was not a plan on its own.
- **The `pushState` patch in phase 4 was never possible** from a content script's
  isolated world; a poll is the backstop that replaces it.
- **The permission allowlist is `content_scripts.matches`, and the manifest
  declares no `host_permissions` at all** (decision 2) — less than the original
  plan asked for, at no cost.
- **The dashboard reads directly *and* never owns the schema** (decisions 4, 14,
  both amended). This file and decision 14 disagreed about phase 7 for the whole
  of phase 6: the roadmap promised `liveQuery` views reading directly, and the
  amendment that promised it had just finished rejecting a panel-side connection
  for the export. The disagreement was real and dissolved rather than settled —
  the objection is to *declaring a schema*, not to opening the database, and a
  connection with no `version()` call does the second without the first.
- **The dashboard is a tab, and it costs no permission** (decision 17). Not in
  the original plan, which said nothing about where the views would live.
  `tabs.query({ url })` is the trap: its filter is ignored without the `tabs`
  permission and returns an empty array rather than an error.
- **A third dedupe key, and the revisit warning that uses it** (decision 7). Came
  out of using phase 3: two hand-entered applications for one role at one
  employer saved as separate records without comment. The fix was a weaker
  company-plus-title key that only ever prompts — and the realisation that the
  same check is far more useful *before* the form is filled in than at save,
  which is what put the revisit warning and the badge into phase 5.
