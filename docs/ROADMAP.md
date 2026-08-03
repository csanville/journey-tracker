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
| 6 | `feat/export-import` | JSON lean/full round-trip, CSV report, skip-duplicate import | Export, wipe, re-import — data identical |
| 7 | `feat/dashboard` | `liveQuery`-backed views: status funnel, over time, per-board yield | Patterns visible across saved data |
| 8 | `feat/submit-detect` | Submission heuristics behind a prompt | Prompt fires on a real submission |
| later | — | Workday, Ashby, iCIMS, SmartRecruiters adapters; diagnostics action | — |

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
- **A third dedupe key, and the revisit warning that uses it** (decision 7). Came
  out of using phase 3: two hand-entered applications for one role at one
  employer saved as separate records without comment. The fix was a weaker
  company-plus-title key that only ever prompts — and the realisation that the
  same check is far more useful *before* the form is filled in than at save,
  which is what put the revisit warning and the badge into phase 5.
