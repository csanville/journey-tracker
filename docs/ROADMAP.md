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
| later | — | Workday, Ashby, iCIMS, SmartRecruiters adapters; diagnostics action; wire up `waitForMigration`; persist a pending submission prompt | — |

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
