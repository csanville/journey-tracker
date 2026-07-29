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

**Amended — the allowlist is `content_scripts.matches`, not `host_permissions`.**
Phase 4 shipped the first content script and the decision's own wording turned
out to name the wrong manifest key. A declarative content script is granted
injection by its own `matches` patterns; `host_permissions` grants something
else — `fetch` to those hosts, their cookies, `webRequest` — and this extension
does none of it. So the manifest declares `content_scripts` and **no
`host_permissions` at all**, which is strictly less than the decision as
written asked for, at no cost. The install warning is the same either way, since
Chrome derives it from both. `optional_host_permissions` for user-added sites is
still the intended shape and is not built yet.

Related: reading a tab's URL from the extension side is what would need the
`tabs` permission, and nothing does — the content script reports its own
`location.href`. The panel calls `chrome.tabs.query` to learn *which* tab it is
next to, which returns an id to any extension; `url`, `title` and `favIconUrl`
are the fields that permission gates, and none of them is read.

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
  IndexedDB, Cache Storage and OPFS, **and exempts extensions from eviction**.

So the extension declares `unlimitedStorage` and also calls
`navigator.storage.persist()`, treating either one as sufficient. Losing a
job-search history to a silent LRU eviction, on a build with no telemetry to
notice it, is the worst failure this project has.

**Corrected.** An earlier draft of this amendment claimed `unlimitedStorage`
lifted the quota while promising nothing about eviction. That was wrong. It came
from the permissions reference, which is simply silent on the subject; Chrome's
storage guide is explicit — "Request the `unlimitedStorage` permission, which
affects both extension and web storage APIs and exempts extensions from both
quota restrictions and eviction." The two defences are not equivalent for an
extension: `unlimitedStorage` is granted at install, whereas `persist()` is
judged against engagement heuristics and was observed returning `false` on a
real install of this extension. The UI therefore warns on neither-defence-holds
rather than on `persist()` alone, since a warning shown on every fresh install
is one that gets ignored when it finally matters.

**Corrected again — the two calls cannot live in the same place.** The first
implementation put both probes in the service worker, where only one of them
works: in the Storage standard `persisted()` is exposed to workers but
`persist()` is `[Exposed=Window]`. The worker's feature check therefore failed
every time and, because it guarded both calls together, skipped the read as
well — so the recorded `storagePersisted` was a fabricated `false` rather than a
measurement, and would have reported genuinely persistent storage as evictable
had `unlimitedStorage` ever been dropped. Reading and requesting are now
separate: the worker reads, the side panel asks, and a `storage/reassess`
message carries the answer back so the single writer still owns settings
(decision 4).

The pattern behind all three corrections in this entry is worth naming, since it
will recur: a protection was recorded as established when only its *declaration*
had been checked. Anything claiming to guard the data needs evidence that the
mechanism actually executes in the context that calls it.

The cost is an extra permission, against a decision-2 posture of asking for as
little as possible. Worth it: the permission is narrow, needs no host access, and
buys the one guarantee this project cannot do without. Whether it adds a
user-visible install warning is unconfirmed — the documentation does not say, and
sources disagree — so check before the first store submission (decision 2's
warning-count argument is what would be affected, not this decision).

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

**Amended — JSON-LD is not universal, and one of the two launch boards has
none.** The premise above says boards emit it for Google Jobs indexing. Lever
does, and a good one. **Greenhouse emits none at all** — the checked-in fixture
is a real capture of a live posting and contains zero `application/ld+json`
blocks. The tier is still ranked first where it exists, but "JSON-LD first" is
not a plan on its own, and the tiers below it are load-bearing rather than
insurance.

**Amended — the order is JSON-LD → embedded state → DOM → OpenGraph.** The
original put OpenGraph second. Reading both boards' real markup showed that
ranking to be actively wrong:

- Lever's `og:title` is `"Lever Demo 2 - Software Engineer"` — employer and role
  welded together. Its DOM has the role alone in `.posting-headline h2`.
- Greenhouse's `og:description` is not a description. It holds the location.

OpenGraph is social-preview copy: written to read well in a link unfurl, not to
name a field, and a board may put anything in it. Anything that knows the site —
the board's own state blob, a selector aimed at the board's own markup — beats it.
It stays in the list, last, because it is the only tier that works on a site
nobody has adapted, which is what makes the generic adapter worth having.

**Amended — the state tier reads script *text*, not globals.** Greenhouse hands
its posting to the page as `window.__remixContext`. A content script cannot read
it: it runs in an isolated world with its own JavaScript heap, so its `window` is
not the page's. The DOM is shared, the state arrives inside a `<script>` element,
and the text of that element is readable. Parsing the text is not a workaround
for a missing API — short of a `world: "MAIN"` injection, which puts extension
code in the page's own context, it is the only path there is.

**Amended — the confidence score is coverage, not accuracy.** It is a 0–1 number
weighting which tier answered each field by how central that field is. It has no
way to know whether the title it read is the right title. It separates "JSON-LD
named the employer" from "we inferred a title from a link preview", which is
useful; read as a probability of correctness it will mislead, so the UI does not
show it as a percentage next to a claim. This is the same failure decision 3
names three times over: a thing recorded as established when only its declaration
was checked.

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

**Amended — a snapshot is a parseable document, and that is what makes it
worth keeping.** Phase 4 built the capture, and the shape it settled on is the
part worth recording. What is stored is a small, well-formed HTML page: the
`<title>`, the link-preview meta tags, every JSON-LD block verbatim, and the
posting's content subtree. That is exactly the input the adapters take, so
re-parsing a snapshot runs the *same* code path as parsing a live page rather
than a second one that quietly diverges. A test parses a fixture, snapshots it,
re-parses the snapshot and demands identical fields.

The 256KB cap is implemented, with truncation and a marker rather than dropping
the capture. The 500-posting retention sweep is **not built** — snapshots are
one-per-posting and replaced on re-capture, so nothing grows without bound
per record, but nothing prunes old ones either. It belongs with export/import in
phase 6, where the storage picture is already on the table.

**Amended — what "trimmed" excludes, and the PII was not hypothetical.** The
whole application form goes: `form`, `input`, `textarea`, `select`, `option`.
The real Greenhouse capture carries a voluntary self-identification
questionnaire — gender, race, veteran status, disability status — and on a
logged-in session those fields are prefilled with the user's answers. So do
inline scripts other than JSON-LD, which is where Greenhouse's state blob lives,
and the questionnaire with it.

That last exclusion has a real cost, and it is the honest trade: Greenhouse's
*best* tier is that blob, so a re-parsed Greenhouse snapshot falls back to the
DOM tier. It loses nothing that matters — title, employer and location are all in
the kept subtree and the page title — but a future adapter that depended on the
blob would find it gone. Keeping the user's demographic answers on disk to
preserve a parser tier is not a trade this project makes.

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

**Amended — the fallback key is company plus requisition, without the title.**
The original plan keyed the fallback on `companyNormalized + jobTitle +
atsReqId`. Implementing it made the title look wrong: a requisition id is
already unique within an ATS tenant, so the title adds no power to distinguish
two records, while giving the match a way to fail whenever a board rewords its
own listing between visits. Every field in a join key is another chance to miss.
The fallback now fires only when *both* remaining parts are present — falling
back to company alone would merge every posting at that employer.

The governing asymmetry across this whole layer: **a missed merge is visible and
recoverable, a wrong merge is neither.** A duplicate record is something the user
can see and fix; two employers silently collapsed into one corrupts every count
downstream with no symptom. So normalization strips only what is unambiguously a
legal form, URL canonicalization removes only named tracking parameters rather
than trusting an allowlist, and an unrecognised ATS URL yields no id rather than
a guessed one.

**Amended — the traps are all ordinary words.** Review of the first
implementation found four wrong-merge bugs, and every one came from a rule that
looked safe in the abstract and collided with everyday language:

- `zoo` and `spa` are legal forms abroad (`sp. z o.o.`, `S.p.A.`) and ordinary
  English nouns here. As suffixes they turned "Bronx Zoo" into `bronx`.
- A Workday requisition pattern that allowed zero letters read the `2026` out of
  `Software-Engineer-Intern_Summer_2026`, giving two internships one join key.
- `ref` and `position` as tracking parameters: the first is how a job *reference
  number* is spelled, the second is a synonym for the posting itself.
- An empty canonical URL is a valid IndexedDB key that matches itself, so two
  postings with no URL were reported as one.

The working test for any new stripping rule is therefore not "is this ever a
legal form / tracking parameter" but "**could this plausibly be part of a name,
or identify the posting**". If yes, leave it. The cost of leaving it is a
duplicate the user can see.

Schema version 2 carries the backfill: version 1 stored these fields as the
caller sent them, and a change in the *meaning* of a persisted field is the kind
that ships silently (decision 9).

**Amended — a third key, because reporting is not merging.** The two identity
keys answer "is this the same record". A user asked why two hand-entered
applications to one employer for one role sailed past each other, and the answer
exposed a flaw in how the asymmetry above had been applied: it is an argument
about *silent collapse*, and `findDuplicate` collapses nothing. It shows a
prompt. A false positive there costs one dismissible click.

So there is now a third key — normalized company plus normalized title — used
only for the prompt, and the match carries which key found it so the UI can say
"you already saved this one" for an identity match and "this looks like one you
already saved" for a resemblance. It is suppressed when both records carry
requisition ids that differ, since the ATS's own identities settle the question
whatever the title says.

The general lesson: **conservatism has to be calibrated to the consequence.** The
same rule that is right for a key that merges records is too strict for a key
that asks a question.

Review then found the third key firing on two *different* listings from one
board — same employer, same title, no requisitions. The suppression rule that
resolves it turns on a distinction worth keeping: **different requisition ids
prove two postings, and so do different URLs on the same host, but different
URLs on different hosts prove nothing.** One job routinely appears on LinkedIn,
on an aggregator and on the company's own board under three unrelated URLs —
that is the case this key exists to catch, so treating any URL difference as
decisive would have thrown away most of its value.

**Amended — extraction adapters do not write `atsReqId`, and the reason is a
third trap of the same family.** Every adapter built in phase 4 leaves the
requisition to `deriveJoinKeys`, which reads it from the URL. That is not an
omission. Pages hand over ids constantly and they are the wrong ids:

- schema.org's `identifier` is usually the board's internal record id.
- Greenhouse's state blob carries `hiring_plan_id` — 6368940002 on the captured
  posting, which is addressed by 8433948002. Worse than merely different: a
  hiring plan spans every opening on it, so keying on it would merge unrelated
  roles at one employer.

`deriveJoinKeys` prefers a caller-supplied `atsReqId` over its own URL reading,
on the reasoning that an adapter which read the page has better information. That
reasoning holds only for a requisition the page states *as* a requisition — a
public "Req #" the applicant would quote in an email. None of the fields above is
that. So the rule is: an adapter writes `atsReqId` only when the page names a
public requisition number, and until one does, none of them writes it.

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

---

## 15. The content script pushes; the worker caches; the panel gets a summary

**Decision.** A content script reports what it parsed, unprompted, along with its
own `location.href`. The service worker caches that per tab in
`chrome.storage.session`. The panel asks the worker for the active tab's
detection and receives a summary **without** the page source. On save it sends
back only the `detectionId`, and the worker writes the snapshot from its own
cache.

**Why.** Each hop is forced by something already decided.

- *Push, not pull.* Pulling would mean the extension asking Chrome what a tab's
  URL is, which needs the `tabs` permission (decision 2). The script reporting
  its own location needs nothing.
- *The worker holds it.* It is already the single writer (decision 4) and it is
  the only context both the page and the panel can reach.
- *Summary without the source.* The trimmed snapshot is up to 256KB of
  page-derived text (decision 6). The panel has no use for it; sending it would
  push it through two message hops into a React state tree for nothing.
- *`chrome.storage.session`, not a module variable.* An MV3 worker is torn down
  after roughly 30 seconds idle (decision 9), and the gap between detecting a
  posting and pressing Save is however long it takes to read a job description.
  In memory the snapshot would be gone by then — every time, silently, decision 6
  defeated by a lifecycle detail. `session` is not written to disk, clears when
  the browser closes, and needs no permission beyond the `storage` already
  declared.
- *An id, not a tab, on the way back.* By save time the tab may have navigated
  on. Looking the snapshot up by id means a tab that moved yields **no**
  snapshot rather than the wrong one, and a snapshot of a different page attached
  to this record is worse than none.

**Consequences.** The cache is bounded to eight tabs and evicts by recency; a
closed tab is forgotten on `chrome.tabs.onRemoved`. Reports are validated on
arrival — not because the sender is untrusted, since only this extension's own
content scripts can reach `onMessage`, but because everything *inside* the
message came off a web page and a page is free to put a megabyte in its
`<title>`. Content scripts are restricted to the one message they need, so
`posting/delete` is not an ambient capability sitting in a context that runs
inside arbitrary markup.

The snapshot write is allowed to fail without failing the save. Decision 6 exists
to make a future re-parse possible, and losing that is not a reason to lose the
application the user just filed.

**Revisit when.** Phase 5 makes the panel follow tabs live. The push half does
not change; what changes is that the panel stops asking only on focus. If the
session cache ever proves too small for how people actually browse, raise the
bound before moving the snapshot anywhere more durable — it is page-derived data
and it should not outlive the browser session.
