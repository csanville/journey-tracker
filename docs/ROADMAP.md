# Roadmap

Phase 0 is committed to `main`. Every phase after it is built on its own branch,
reviewed, then merged.

| Phase | Branch | Scope | Done when |
|---|---|---|---|
| 0 | `main` | Node 24, CRXJS scaffold, MV3 manifest, empty side panel | Panel opens in Chrome |
| 1 | `feat/data-model` | Types, `schemaVersion`, storage adapter, dedupe/normalise helpers, Vitest | Tests green, no UI |
| 2 | `feat/sidepanel-form` | Full form, theme, manual Save, dirty tracking, save → wipe → fresh form | Enter a job by hand; it survives a reload |
| 3 | `feat/resume-library` | File import, nickname (defaults to filename), IndexedDB blobs, read-only "Resume Used" selector | Import a PDF, attach it, reopen — still there |
| 4 | `feat/extraction` | Adapter registry, generic JSON-LD, Greenhouse, Lever; fixture tests | A real posting fills the form |
| 5 | `feat/live-sync` | Tab listeners, swap rules, dirty-form banner | Tab between postings; the form follows |
| 6 | `feat/export-import` | JSON round-trip, CSV report, backup-age indicator | Export, wipe, re-import — data identical |
| 7 | `feat/dashboard` | Counts by status, applications over time, outcomes per resume | Patterns visible across saved data |
| 8 | `feat/submit-detect` | Submission heuristics, behind a prompt | Prompt fires on a real submission |
| later | — | Workday, Ashby, iCIMS, SmartRecruiters adapters | — |

## Decisions already made

- **Storage.** `chrome.storage.local` holds 10 MB, survives browser restarts, and is
  cleared only on uninstall — so export is a backup and portability feature, not a
  save-or-lose-it ritual. `chrome.storage.sync` is too small (~100 KB) and would route
  data through Google's servers. Resume bytes go in IndexedDB, not `storage.local`.
- **Export.** JSON is the canonical, lossless backup format. CSV is the human-facing
  report — it opens in Excel and costs no dependencies. No `.xlsx`.
- **Import.** Skip duplicates. Never overwrite existing records.
- **Extraction order.** The generic schema.org `JobPosting` (JSON-LD) reader comes first;
  site adapters are overrides layered on top of it. Workday is last — it is a heavy SPA
  that fetches through internal JSON APIs.
- **Submission detection is last, and prompts.** Detecting a real submission across sites
  is unreliable; a false positive writes a junk record and a false negative loses a real
  one. Manual Save is the v1 contract.
- **Live re-fill guards your typing.** A pristine form auto-fills. Once you have edited any
  field, a new posting announces itself as a banner instead of overwriting your work.
- **Permissions stay narrow.** `chrome.tabs.onActivated` reports a tab id without the broad
  `"tabs"` permission, and the content script reports its own findings — so the manifest
  needs only `sidePanel` and `storage` plus specific job-board matches.
- **Schema versioning from day one.** `schemaVersion` on the root of stored data, so
  migrations and cross-version imports stay possible.
