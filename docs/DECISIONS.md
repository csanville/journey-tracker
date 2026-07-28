# Architecture decisions

Each entry records what was decided, why, and — most importantly — the condition
under which it should be reconsidered. A rule whose revisit condition has been
met is not binding; raise it rather than silently working around it.

Entries 1–11 came from prior research. Numbering is stable so references stay
valid: entries are amended in place rather than renumbered, and anything changed
after the fact is marked **Amended**. New decisions are appended from 12 onward.

This file is the reference for decisions not otherwise specified. `ROADMAP.md`
sequences the work; where the two disagree, this file wins and the roadmap gets
fixed.

---

## 1. Data stays on the device

**Decision.** No backend. The only egress is a user-initiated export.

**Why.** This is a personal tool first and a Chrome Web Store listing second.
Local-only lets the data-usage disclosure say "does not collect user data,"
which is the cheapest possible review posture and an honest selling point for an
extension that watches someone's job search — a topic users are reasonably
private about.

**Consequences.** No crash reporting and no usage analytics. Bugs arrive blind.
Mitigated by a "copy diagnostics" action that puts adapter versions, the failing
hostname, and a redacted parse result on the clipboard for the user to paste
into an issue. That is compliant because the user initiates it and chooses where
it goes. The diagnostics action is not yet built and is not scheduled; it is the
intended answer to blind bug reports, not a commitment for any current phase.

**Revisit when.** Cross-device sync becomes a real requirement, or the extension
grows a user base large enough that blind bug reports stop scaling. Note that
adding any automatic egress means amending the store disclosure and likely
triggering re-review — it is a product decision, not an implementation detail.

---

## 2. Narrow permissions, `activeTab` for the long tail

**Decision.** Static allowlist in `host_permissions`; `activeTab` +
`chrome.scripting` for unknown sites; `optional_host_permissions` with a runtime
request for user-added sites.

**Why.** `<all_urls>` produces the "read all your data on all websites" install
warning and slows Chrome Web Store review. Because capture is click-initiated,
`activeTab` genuinely covers the unknown-site case and produces no install
warning at all. The install dialog is the single biggest lever on conversion for
a free extension.

**Amended.** A static `host_permissions` allowlist is not warning-free either —
Chrome names the hosts ("Read and change your data on boards.greenhouse.io"), and
collapses them into a vaguer warning once the list grows. It is a much milder
dialog than `<all_urls>`, not the absence of one. The `activeTab` half of the
decision is what carries no warning, and it is unaffected.

**Consequences.** Slightly more code — a permission-request flow and a runtime
injection path in addition to declarative content scripts. Auto-detection
(showing a badge, or live-filling the panel, before the user clicks) only works
on allowlisted hosts; everywhere else the user must initiate. That boundary is a
user-visible behaviour difference and should be made obvious in the UI rather
than left to be discovered.

**Revisit when.** A feature genuinely requires passive observation across
arbitrary domains. Before doing that, check whether the same insight can be
derived from user-initiated captures instead.

---

## 3. IndexedDB, with snapshots in a separate store

**Decision.** Dexie over IndexedDB for records. `postings` and `snapshots` are
separate object stores. `chrome.storage.local` is settings only.

**Why.** `chrome.storage.local` is a key-value blob store with no query or index
support, and `chrome.storage.sync` caps at 100KB total and 8KB per item, which
rules it out for records entirely.

Splitting snapshots out is the important half: raw page captures are orders of
magnitude larger than the records themselves, and leaving them on the record
means every dashboard aggregation drags megabytes through memory for fields it
never reads.

**Amended — the load-bearing reason is snapshots, not aggregation.** At the scale
this decision itself predicts (thousands of records, not millions), loading every
record out of `chrome.storage.local` and aggregating in memory would be perfectly
adequate — a few thousand records is a few megabytes. What actually forces
IndexedDB is decision 6: snapshots exceed the 10MB `chrome.storage.local` budget
almost immediately. This matters because if snapshots are ever dropped, this
decision loses most of its justification and should be re-examined rather than
inherited.

**Amended — IndexedDB is evictable and `chrome.storage.local` is not.** This
decision trades away durability, which the original entry did not note:

- `chrome.storage.local` persists until the extension is uninstalled and is not
  subject to eviction.
- IndexedDB defaults to **best-effort** storage, which Chrome evicts by LRU under
  disk pressure — the whole origin's data, not merely the excess.
- `unlimitedStorage` grants unlimited quota for `chrome.storage.local`,
  IndexedDB, Cache Storage and OPFS, but quota and eviction are separate
  concerns; the permission documentation makes no eviction guarantee.

So the extension must call `navigator.storage.persist()` and check the returned
boolean, surfacing a warning if persistence is denied. Losing a job-search
history to a silent LRU eviction, on a build with no telemetry to notice it, is
the worst failure this project has.

**Consequences.** Fetching a snapshot is a second lookup by posting id. That is
fine — snapshots are only read during re-parse and debugging, never during
normal dashboard rendering.

**Revisit when.** Record count reaches a scale where indexed queries are
measurably slow. Expect this not to happen. Do not preemptively build
materialized views.

---

## 4. Single writer: the service worker

**Decision.** Content scripts and the dashboard never write to IndexedDB. All
mutations are messages to the service worker.

**Why.** Content scripts *cannot* write to the extension's IndexedDB — they run
in the page's origin, not `chrome-extension://<id>` — so that half is forced.
The dashboard *can*, which is exactly the trap: the dashboard may be open in
several tabs at once, and concurrent writers racing on dedupe and schema-version
logic produces corruption that is painful to reproduce.

**Consequences.** One place enforces dedupe, schema version, and normalization
invariants. The dashboard needs reactivity to see worker writes — Dexie's
`liveQuery` handles this without polling. The message layer must tolerate the
service worker being torn down mid-conversation (see decision 9): callers retry,
and every mutation message is idempotent so a retry cannot double-write.

**Revisit when.** Never, realistically. If a write path from the dashboard seems
necessary, add a worker message instead.

---

## 5. Extraction is tiered, JSON-LD first

**Decision.** JSON-LD `JobPosting` → OpenGraph/meta → embedded app state → DOM
selectors, in that order, per host adapter.

**Why.** DOM selectors are the highest-maintenance surface in the entire
project; boards restructure markup with no notice and no versioning. JSON-LD is
emitted by most boards for Google Jobs indexing, is schema-standardized, and
changes far more slowly because changing it costs them SEO. Every field pulled
from a tier above the DOM is a field that does not break on redesign.

**Consequences.** Adapters are more layered than a straight querySelector
approach. Coverage of a given board may be partial at the higher tiers, which is
why adapters return partial results with a confidence score rather than
all-or-nothing.

**Revisit when.** Never wholesale. Individual adapters may skip tiers a
particular host does not implement.

---

## 6. Store the raw snapshot; version the adapter

**Decision.** Every capture stores the raw source it parsed, tagged with the
adapter version that produced the record.

**Why.** Parsers are wrong in ways you discover months later. Without the raw
source, a parser bug means permanently lost data. With it, a fix is followed by
a re-parse of history. This also enables supporting a board retroactively — a
posting captured by the generic fallback can be upgraded once a real adapter
exists.

**Consequences.** Storage growth, and the snapshots contain page-derived PII
(the user's own profile data, recruiter names) when captured from logged-in
sessions. Mitigated by storing a trimmed subtree rather than the full document,
capping retention, and excluding snapshots from the `lean` export.

**Amended — "trimmed" and "capped" need concrete values.** Left vague these
mitigations do not exist. Starting parameters, to be confirmed when snapshots are
first written:

- Capture the JSON-LD block plus the posting's content subtree, not the full
  document — never `<head>` scripts, cookies, or anything outside the posting.
- Cap a stored snapshot at 256KB after trimming; store a truncation marker rather
  than dropping the snapshot entirely when it exceeds that.
- Retain snapshots for the 500 most recent postings; drop the oldest beyond that.
  Records are never dropped, only their snapshots.

**Revisit when.** Storage pressure becomes real. Tighten retention or trimming
before abandoning snapshots.

---

## 7. Records carry join keys for the external tracker

**Decision.** `companyNormalized`, canonical `url`, and `atsReqId` are captured
on every record.

**Why.** The extension observes *applied*; a separate Gmail-derived tracker
observes *responded*. Joining them is where the real funnel analysis comes from.
Fuzzy-matching company plus role plus date window is unreliable enough that you
stop trusting the output. The ATS requisition ID — extractable from
Greenhouse/Lever/Ashby/Workday URLs and frequently repeated verbatim in the
confirmation email — is a hard key.

**Amended — the external tracker is real but early.** It exists as a personal,
lightly-built tool with no stable schema to target. So these keys are carried for
their in-extension value first: they are what dedupe runs on, and they are
expensive to backfill later. No work is scheduled to integrate with the external
tracker, and no field is shaped around a schema that has not settled.

**Consequences.** Company normalization needs a real implementation (case,
suffixes, common aliases) rather than a trim. URL canonicalization must strip
tracking parameters consistently, since the same posting is reachable via many
parameterized URLs.

**Revisit when.** The external tracker settles into a real schema worth
integrating with, or is retired. The keys remain useful for in-extension dedupe
regardless.

---

## 8. `viewed` and `applied` are separate states

**Decision.** A record's state distinguishes having seen a posting from having
applied to it, and `applied` is never inferred from `viewed`.

**Why.** Every meaningful metric — response rate, funnel conversion, per-board
yield — depends on this distinction. It cannot be reconstructed after the fact:
if it is not captured at the moment of submission, the information is gone.

**Amended — this entry originally also specified the detection mechanism.** How
`applied` gets recorded is a separate decision with a very different confidence
level, and it is now decision 12. This entry covers only the state model, which
is not up for revision.

**Revisit when.** Never.

---

## 9. Migrations ship with every schema change

**Decision.** Forward-only, idempotent migrations run on `onInstalled` with
`reason === 'update'`. No schema version ships without one.

**Why.** Extensions auto-update silently in the background. There is no moment
at which the user can be asked to back up, intervene, or approve. A missing
migration is silent data loss on someone else's machine, discovered later, with
no telemetry to detect it.

**Amended — the service worker can die mid-migration.** MV3 workers are torn down
after roughly 30 seconds idle and can be killed at any point. Forward-only and
idempotent covers re-running a partial migration, but not a panel that opens and
reads half-migrated data in the meantime. So a migration sets a
`migrationInProgress` flag in `chrome.storage.local` before starting and clears it
on completion; the panel and dashboard wait on that flag rather than querying
through it. `chrome.storage.local` specifically, because it is the one store the
migration is not itself rewriting.

**Consequences.** Migration tests from every prior version are part of the test
suite, and the number of them grows over time. Accepted cost.

**Revisit when.** Never.

---

## 10. UUIDs and `updatedAt` despite being local-only

**Decision.** Every record carries a UUID and an `updatedAt` timestamp even
though nothing syncs today.

**Why.** These are the two fields any future sync or merge layer requires, and
they are nearly free to add now and expensive to backfill later — retrofitting
stable identity across records that already exist on users' machines is a
migration problem with no good answer.

**Consequences.** Two fields of overhead. They also make import behave correctly
today (see decision 14), so the cost is already partly repaid.

**Revisit when.** Never remove.

---

## 11. Single purpose

**Decision.** The extension does one thing: track and analyze the user's job
applications.

**Why.** Chrome Web Store policy requires a narrow single purpose, and bundling
unrelated functionality is a common rejection cause. Adjacent ideas — resume
tooling, interview prep, salary research — are separate extensions.

**Amended — resolves the resume question.** A record stores `resumeUsed` as a
label, chosen from previously used values or typed. The extension does **not**
import, store, or manage resume files. Which resume was sent is an attribute of an
application and belongs here; the file itself is resume tooling and does not. The
user already has their own resumes on their own machine, so storing copies adds
custody of sensitive documents, a large chunk of the storage budget, and store-
review surface, in exchange for very little. A full resume library remains a
plausible future extension, not a phase of this one.

**Revisit when.** A feature is arguably in scope. The test is whether it serves
tracking or analyzing applications the user has made, not whether it is
job-search-adjacent.

---

## 12. Submission detection is deferred, and prompts rather than writes

**Decision.** Manual save is the recording mechanism for v1. Automatic submission
detection ships late, and when it fires it asks — "Looks like you applied. Save
this?" — rather than writing a record on its own.

**Why.** Split out of decision 8, which correctly requires that `applied` be
captured at the moment it happens but then assumed a detection mechanism whose
reliability does not match the rest of the design. Detecting a genuine submission
across sites is unreliable: postings submit through iframes, background requests,
and SPA route changes with no signal in common. A false positive writes a junk
record; a false negative silently drops a real one. Both corrode trust in a
tracker, which is the entire product.

A manual save satisfies decision 8 in full — it captures `applied` at the moment
of submission, using the user as the signal instead of a heuristic.

**Consequences.** The user does one click per application that a perfect detector
would have saved them. Confirmation detection, when built, is per-ATS and needs
its own signals alongside the parse adapters.

**Revisit when.** A detector reaches a precision on real submissions high enough
that silent writes would not manufacture history. Auto-writing without a prompt
needs stronger evidence than auto-prompting did.

---

## 13. The live form never overwrites the user's own typing

**Decision.** A pristine form auto-fills from the active tab. Once any field has
been edited by hand, a newly detected posting announces itself as a dismissible
banner and waits for the user to accept it.

**Why.** Auto-filling is the core interaction and should feel effortless while
the form is untouched. But losing typed notes by tabbing away to check something
and coming back is the kind of small betrayal that stops people trusting a tool
with anything they care about.

**Consequences.** The form needs dirty tracking from the moment it exists, not
retrofitted once live sync arrives. Dismissing the banner must not discard the
detected posting silently — the user should be able to get it back.

**Revisit when.** Never as a principle. The specific affordance can change.

---

## 14. Export is JSON; the spreadsheet is a report, not a format

**Decision.** JSON is the canonical export and the only accepted import format,
in `lean` (records only) and `full` (records plus snapshots) variants. CSV is a
one-way human-facing report. Import skips records whose id already exists and
never overwrites.

**Why.** Because the data lives only on the device (decision 1), export is the
sole backup and portability path and has to round-trip losslessly. Spreadsheets
mangle dates, leading zeros in requisition ids, and encodings, and cannot carry
snapshots at all — fine for reading, unacceptable for restoring. CSV costs no
dependency and opens directly in Excel, so a real `.xlsx` writer earns nothing.

Skip-on-conflict is the safe default: a duplicate id on import is far more likely
to be a re-imported backup than a deliberate correction, and overwriting silently
destroys the newer record.

**Consequences.** Merging genuinely divergent histories is not supported. The
`lean` variant exists so a backup can be shared or archived without carrying the
page-derived PII that snapshots contain (decision 6).

**Revisit when.** A real merge case appears — the same history edited on two
machines. That needs `updatedAt` (decision 10) and an explicit conflict UI, not a
silent policy change.
