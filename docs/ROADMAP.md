# Roadmap

`DECISIONS.md` records *what* was decided and why. This file sequences the work.
Where the two disagree, `DECISIONS.md` wins and this file gets fixed.

Phase 0 is on `main`. Every phase after it is built on its own branch, reviewed,
then merged.

| Phase | Branch | Scope | Done when |
|---|---|---|---|
| 0 ✅ | `main` | Node 24, CRXJS scaffold, MV3 manifest, side panel that probes storage | Panel opens in Chrome |
| 1 | `feat/schema-storage` | Dexie schema, migration harness, single-writer message layer, storage persistence | Tests green, no UI |
| 2 | `feat/normalization` | Company normalization, URL canonicalization, `atsReqId`, dedupe | Fixture tests green, no UI |
| 3 | `feat/sidepanel-form` | Full form, theme, manual save, dirty tracking, save → wipe → fresh form | Enter a job by hand; it survives a reload |
| 4 | `feat/extraction` | Tiered adapters, snapshots, adapter versioning, fixture tests | A real posting fills the form |
| 5 | `feat/live-sync` | Tab listeners, swap rules, dirty banner, `activeTab` capture for unknown sites | Tab between postings; the form follows |
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
- **Dedupe** on canonical URL, falling back to `companyNormalized + atsReqId`.
  `jobTitle` was dropped from the fallback key during implementation: a
  requisition id is already unique within a company, so the title added no
  discriminating power and only gave the match a way to fail when a board
  rewords its own listing (decision 7).

**Done when** a fixture set of messy real-world URLs and company strings collapses
to the expected records, including the near-miss cases that should *not* merge.

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
