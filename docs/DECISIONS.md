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

The patterns name **board hosts, not vendors**. The first version matched
`https://*.greenhouse.io/*`, which review caught: `app.greenhouse.io` and
`my.greenhouse.io` are the logged-in recruiter console — live hosts, full of
candidate data — and `www.` is marketing. The content script would have parsed
and snapshotted recruiter pages and offered them in the panel. Company
subdomains do not resolve, so the wildcard bought nothing for it. The general
rule, now enforced by a test: **a match pattern names a host that serves job
postings, never an apex a vendor also runs its own product on.**

Related: reading a tab's URL from the extension side is what would need the
`tabs` permission, and nothing does — the content script reports its own
`location.href`. The panel calls `chrome.tabs.query` to learn *which* tab it is
next to, which returns an id to any extension; `url`, `title` and `favIconUrl`
are the fields that permission gates, and none of them is read.

**Amended — "click-initiated" is not a click of the user's choosing.** Phase 5
built the `activeTab` half and found the decision had been assuming a freedom
Chrome does not offer. `activeTab` is granted by exactly four gestures: invoking
the extension's action, a context menu item, a `commands` keyboard shortcut, and
an omnibox suggestion. **A button inside an extension page grants nothing.** So
the obvious affordance — a "Read this page" button in the side panel, next to the
form, where anyone would look for it — cannot work, and no amount of care in the
panel can make it work.

The action is spoken for as well. `openPanelOnActionClick` is what makes the
toolbar icon open the panel, and it means `chrome.action.onClicked` never fires,
so the one gesture users already understand is committed to something else. That
leaves the context menu and the keyboard shortcut, and the manifest declares both
— which is why `contextMenus` appears in the permission list. It buys the only
discoverable gesture available; the shortcut alone would be a feature nobody
finds. Real-world testing confirmed the right-click is how the feature actually
gets used.

The panel's job is therefore to *point at* the gesture rather than offer it, and
it does so only when nothing was detected, which is exactly when somebody would
be wondering. The hint also names the pages Chrome refuses outright — its own
pages, the Web Store, PDFs — because the panel now opens on a refused read as
well as a successful one, and telling somebody who just right-clicked a PDF to
right-click the page reads as a broken menu item rather than as a limit.

**Amended — the injected bundle cannot be the declared content script.** CRXJS
compiles a declared content script into a small loader that dynamically
`import()`s the real module, and that import is permitted only from the origins
it lists in `web_accessible_resources` — which are the allowlisted boards.
Injecting that file into an unknown site fails at the import, silently, in a page
console nobody is reading, on precisely the sites `activeTab` exists to reach. So
the injected script is a second, separate Vite build: one IIFE, every dependency
inlined, nothing to fetch at runtime, at a fixed filename the worker can name
without guessing a content hash. Every build path has to run it — a build that
omits it fails at injection time with `Could not load file`, logged only in the
worker console.

**Consequences.** Slightly more code — a permission-request flow and a runtime
injection path in addition to declarative content scripts. Auto-detection
(showing a badge, or live-filling the panel, before the user clicks) only works
on allowlisted hosts; everywhere else the user must initiate. That boundary is a
user-visible behaviour difference and should be made obvious in the UI rather
than left to be discovered.

Three permissions carry the capture path — `activeTab`, `scripting`,
`contextMenus` — and none of them adds an install warning, which is the whole
point of the posture. `contextMenus` is the one that could be dropped, at the
cost of the only discoverable way in.

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

**Amended — the reader declares no schema.** "The dashboard reads directly" was
written here before decision 14 worked out what opening the database costs: the
context that declares a version is the context that performs Dexie's structural
upgrade, and a dashboard open in three tabs would race the worker for it. Phase 7
resolves it by having the dashboard construct its `Dexie` with **no `version()`
call at all**, which opens in dynamic mode — it adopts whatever stores and
indexes are on disk, and having no version of its own, it has nothing to upgrade
*to*. Reads and `liveQuery` work unchanged; the worker keeps sole possession of
the schema.

Two consequences fall out of it, both pinned by tests in `src/dashboard/db.test.ts`
because both would otherwise fail silently on someone's real data. A dynamic
connection **cannot create** the database, so the first-ever dashboard open on a
fresh profile has to ask the worker to — one `status` message, which is enough
because every request is dispatched through `await ready()`. And the tables it
returns are **untyped**, so there is exactly one cast at the boundary in
`readPostings`.

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
the capture — including when the *head* alone exceeds it, which a board that
inlines its whole listing as JSON-LD can manage on its own. Cutting only the body
left the document still over the cap, and the validator then discarded it
outright: no snapshot, no marker, nothing to say anything had been dropped. The
head is cut too, keeping its front, where `<title>` and the first JSON-LD block
sit.

**Amended — the 500-posting retention sweep is now built.** It was deferred out
of phase 4 with the note that it belonged with export/import, and phase 6 built
it. Two details settled in the doing:

- It orders by the snapshot's own `capturedAt` rather than by the posting's
  `updatedAt`. That index already exists, it needs no join, and the two only
  disagree for a record edited long after its page was read — where keeping the
  older capture is not obviously better anyway.
- **Records are never dropped, only their snapshots**, exactly as this entry
  said. A swept posting still lists, still dedupes, still exports; it has lost
  only the ability to be re-parsed after a future adapter fix, which is the one
  thing this decision is willing to trade away.

It sweeps where snapshots are created — after a capture is stored, and after an
import — and costs a single `count()` until the cap is actually passed. The
import path is swept for a reason: restoring a `full` backup taken before the
sweep existed should not be a way to reinstate a thousand snapshots.

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

**Amended — the ceiling is decision 2, not detector quality.** Phase 8 scoped
this and found the entry had been reasoning about the wrong constraint. The
paragraph above argues that detection is *unreliable*; the binding fact is that
on almost every site it is **impossible**.

Detecting a submission needs code running on the page at the moment it happens,
and this extension has exactly two ways to put code on a page: the content
script the manifest declares, and an `activeTab` injection granted by a gesture.
`activeTab` is revoked on navigation — which is what a submission usually is —
and the injected bundle is a one-shot reader besides. So Workday, iCIMS, Ashby,
SmartRecruiters, LinkedIn Easy Apply and every board embedded in a company's own
careers page are out of reach, and no improvement in heuristics moves them. The
only thing that would is `<all_urls>`, which decision 2 exists to refuse.

The value is inverted by the same fact, which is the part worth remembering
before anyone plans this again: detection can only run on the boards where the
flow already works best — the panel auto-fills, the revisit banner answers, the
record is one click away. The long tail, where the user does the most work, is
exactly the part that cannot be reached. A general "submission detection"
feature is therefore not a thing this extension can have, and describing what
ships as one would be a claim that outruns what is true.

**Amended — what one board actually gives, and what another refuses to.** What
survives is not a heuristic at all. A submitted Greenhouse application lands on
`job-boards.greenhouse.io/<token>/jobs/<id>/confirmation`: a real page load,
publicly indexed, carrying the job id, so it joins back to a stored record by
URL. `lib/confirmation.ts` matches that one shape and nothing else.

Two implementation facts fell out of it that were not obvious:

- **The join must run against the record set, never the detection cache.**
  Decision 15's `onUpdated` listener drops a tab's detection on a real page
  load, and a confirmation page is one — so the detection for the posting being
  confirmed is already gone when the confirmation arrives. The worker cannot
  special-case it either, because `changeInfo.url` is withheld without the
  `tabs` permission.
- **The content script filters; the worker decides.** The script sends only when
  a URL matches, so ordinary navigation costs no message and does not wake the
  worker (decision 9 rests on it being idle enough to be torn down). The worker
  re-runs the derivation itself, because deciding that somebody applied to
  something belongs on the trusted side of the boundary — the same reasoning as
  `sanitizeReport`.

**Lever gets nothing, and the reason is a decision rather than an omission.** Its
apply form is a distinct URL, which is a usable *intent* signal, but the page
after a successful submission is an employer-configurable "Application Success
Page URL" that may redirect off-host entirely. There is no stable shape to match
**by design**, and inventing one would be this document's most repeated failure
(decision 3): a mechanism recorded as working when only its existence was
checked. A test pins the absence so a future guess has to argue with it.

A prompt is also raised only for a posting **already stored**. Manufacturing a
record from a confirmation page — which carries no employer, title or
description worth trusting — would put junk in the tracker to save one click.

**Revisit when.** A detector reaches a precision on real submissions high enough
that silent writes would not manufacture history. Auto-writing without a prompt
needs stronger evidence than auto-prompting did.

Note what would *not* be enough on its own: the Greenhouse signal is essentially
exact, and it is still behind a prompt, because precision on one board says
nothing about a mechanism and the failure mode of a wrong silent write is a
history the user cannot tell is wrong. Widening coverage is the other axis, and
it is gated on decision 2 rather than on this entry.

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

**Amended — "dirty" and "has anything in it" are different questions.** Phase 4
made the fill's own output the dirty baseline, which is correct: after a fill the
form is untouched, so Discard should not be lit. Wiring Discard to `dirty`
directly then disabled it on a *full* form, stranding anyone who filled from the
wrong posting — which is what a board that renders late produces — with every
field to clear by hand. `dirty` answers "has the user typed something worth
protecting"; Discard is asking "is there anything here". Both are needed, and one
cannot stand in for the other.

Related, from the same review: every affordance that writes into the form has to
be locked while a save is in flight, not merely the inputs. The fill button sat
outside the disabled fieldset, so a fill landing mid-save wrote into a draft that
had already been snapshotted for writing — the record saved with pre-fill values
and manual provenance, and the reset that follows a save then wiped the fill.

**Amended — the rule is a function, and it has four inputs, not two.** Phase 5
made the form follow the tab, which turns this decision from a description into
code that runs on every detection. It lives in `sidepanel/fill.ts` as
`swapAction`, deliberately outside React: a rule expressed as interacting `if`s
inside an effect is a rule nobody can check, and this one is worth checking.

"Pristine" means **untouched, not empty**. A form auto-filled from the last
posting and left alone is still pristine, and it is exactly the case that must
swap — it is what tabbing between two postings looks like. Beyond `dirty`, three
further states must suppress a swap, and each was found by getting it wrong
first:

- *A save in flight.* The draft has already been snapshotted for writing, so a
  fill landing in the gap is written as the pre-fill values and then wiped by the
  reset. It looks like it worked.
- *An unanswered question.* The duplicate prompt and a failed save are neither
  busy nor dirty, so any re-report refilled the form and reset the phase —
  "You already saved this one: Discard / Save anyway" vanished along with the
  draft it was asking about, and the user had answered nothing.
- *A form the user has just emptied.* Discard clears the draft, which makes the
  form not dirty, which made the page eligible to fill it straight back in one
  frame later. Discard must therefore mark the current detection dismissed rather
  than clearing the mark, or there is no reachable state in which a posting tab's
  form stays empty — the same failure this decision was already amended once to
  fix, arriving by a new route.

**Amended — a confirmed replace replaces.** An explicit fill layers onto the
current draft on purpose, so that status, notes, tags and the applied date — none
of which a job board knows anything about — survive it. But when the fill would
overwrite typed work the button first asks *"Replace what you have typed?"*, and
answering yes to that question then kept the notes anyway: tabbing to a different
job and confirming carried the previous job's notes onto it, under a heading
naming the new one. Only the confirmed path builds from an empty draft. The
unconfirmed one still layers, and must — no confirmation was asked for because
there was nothing to protect.

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

**Amended — a restore is not a save, and the difference is the timestamps.**
Phase 6 built this, and the first thing implementing it exposed is that import
cannot go through `upsertPosting`. That path stamps `updatedAt` with the present,
which is correct for a save and wrong for a restore: a re-imported history
arrives with every record edited today, in one indistinguishable block, and
"newest first" means nothing ever after. Nothing fails, nothing warns, and the
information is gone. So the import path writes records verbatim — ids,
`createdAt` and `updatedAt` as the file carried them — and that is what makes
export-wipe-import a round trip rather than a copy.

The join keys are the exception, re-derived on the way in like every other write
(decision 4). A file is the one input that could carry keys computed by a
different build, or edited by hand.

**Amended — the importer has to migrate what it imports.** A backup restored
after an upgrade holds records written by whatever build the user had, and
**nothing else would ever bring them forward.** The migration harness keys off
`dataVersion`, which the worker brought up to date at startup, so from its point
of view there is nothing pending; the records arrive stale and stay stale. That
is decision 9's failure exactly — silent, on someone else's machine, with no
telemetry — reaching the database through the one door that does not go past the
version stamp.

`migrateImportedRecords` runs every migration between the file's declared version
and the current one, across the whole table rather than the imported rows, since
a `Migration` is defined over the database and narrowing it would be a second
implementation of every migration ever written. Safe because they are all
required to be idempotent. It is unreachable today — the exporter always writes
at the current version, so no file can be behind — and that is exactly why it had
to be built now: by the time one exists it will already be on somebody's disk.

**Amended — the export needs a wipe next to it.** "Erase everything" is in
scope, which the original entry did not consider. An export nobody has ever
restored is a backup of unknown shape, and wiping and re-importing is the only
way a person finds out theirs is real. On a build whose data lives in exactly one
place (decision 1), that is not a power-user feature.

**Amended — batching, and where the code runs.** A `full` export is records plus
up to 500 snapshots of up to 256KB, so it is tens of megabytes; handed over in
one `sendMessage` it would be serialized and held in two contexts at once. Every
export and import message therefore carries a slice, sized by bytes rather than
by rows — 200 records or 4 snapshots.

The alternative considered and rejected was letting the panel open its own Dexie
connection for the read half, which decision 4 permits: it forbids *writes* from
the dashboard, and phase 7's `liveQuery` views will read directly. It was
rejected because a panel that opens the database is also the context that
performs Dexie's structural upgrade on the next release adding an index — and
that upgrade would then be racing the worker's own connection. The read half
being marginally cheaper is not worth putting a schema upgrade in the UI.

> **Since amended by phase 7.** The objection above is to *declaring a schema*,
> not to opening the database, and the two are separable: a connection built
> with no `version()` call reads without ever upgrading. See decision 4's
> amendment. It does not change the conclusion here — export still batches
> through the worker, because import is a write either way and splitting the two
> halves across two paths buys nothing.

**Amended — "never overwrites" has to hold against the file, not just the
store.** Review found the rule enforced by a single `bulkGet` taken before any
write, so two records sharing an id *within one batch* both saw nothing stored,
both counted as imported, and the last one won. A record lost, and the summary
reporting it restored. An export cannot produce this — ids are keys there — but a
file hand-merged from two machines or two backups concatenated can, and those are
exactly the files somebody assembles when they are trying hard not to lose
anything. The general shape is worth naming, because it recurs wherever a batch
is checked against a store: **a uniqueness check that reads before the loop
tests the batch against the past, not against itself.**

**Amended — a count of what was written is a promise, and the retention cap can
break it.** The snapshot sweep runs after each import batch, so restoring a
year-old `full` backup into a database of newer captures inserted every page and
reclaimed it immediately — while reporting hundreds added. Pages are counted
after the sweep now, and the reclaimed ones are reported separately as
*dropped*: they are neither imported nor skipped, and that number is the only
place the 500-page limit is ever visible to a user. A restore that silently kept
none of its pages would otherwise read exactly like one that kept them all.

**Amended — the migration debt needs somewhere durable to live.** The importer's
migration (above) originally ran inline and recorded nothing, which failed twice
over. It ran once per 200-record batch, rewriting the whole table each time — 25
full passes for a 5,000-record restore, flapping `migrationInProgress` at every
waiting reader — and a chain interrupted between two steps left records at an
intermediate version with **nothing that would ever finish them**, since
`dataVersion` was already current before the import began.

So the debt is written down: `importedBelowVersion` in settings, set before the
work, stepped after each migration, cleared on completion, and checked by the
worker at every start. The migration itself is deferred to the last batch, which
the panel flags — only the panel knows where a file ends. A run that never
reaches that flag, because a batch failed or the panel closed, is finished at the
next worker start rather than lost.

This is the third time in this document that a protection turned out to be
declared rather than executed (decision 3 names the pattern). Here the
declaration was a function that ran; what was missing was any record that it had.

**Amended — a wipe and a restore move every badge at once.** Neither operation
told anybody. The badge is painted from a detection-to-record match, so it is a
claim about the *record set* as much as about the page (decision 16) — and these
are the only two operations that move the record set under every open tab
simultaneously. Erasing everything left tabs asserting records that had just been
deleted, contradicting the panel's own revisit banner, which re-queries; a
restore left them dark on pages it had just tracked. Both now re-answer the
question for every tab holding a detection, which the cache's eight-tab bound
makes cheap however large the import was.

**Amended — the destructive dialog must not be reachable before the counts
are.** Every count in the panel falls back to zero while the worker has not
answered, so the erase confirmation asked "Erase 0 records and 0 pages?" over a
full database — understating the stakes in the one place that must not — and the
milder of its two warnings won, because `status?.lastBackupAt === null` is false
for `undefined`. Guarding the button was not enough, since the confirmation
outlives a status that goes away. The general rule: **a fallback value chosen for
a quiet UI becomes a lie in a dialog that asks for consent.**

**Amended — the CSV needed a security decision the entry did not anticipate.**
Every string in a record was chosen by whoever wrote the job posting. Excel and
Sheets evaluate a cell that opens with `=`, `+`, `-` or `@`, and a formula is not
inert — `=HYPERLINK` and `=IMPORTDATA` reach the network — so a hostile job title
would execute when the user opened their own backup. Every cell is prefixed with
the apostrophe that spreadsheets use to mark text. It fires on ordinary text as
well (a note beginning "- called back" gets one), which is the right direction to
be wrong in for a file that is never parsed back.

The guard tests for **any** leading whitespace as well as the four characters,
which the first implementation got wrong by naming `\t` and `\r` specifically:
spreadsheets trim a field before deciding what it is, so a single leading space —
entirely ordinary in scraped markup — walked straight through it.

The file also carries a UTF-8 BOM, without which Excel decodes it as the system
codepage and mangles every accented company name, and uses CRLF per RFC 4180.
None of this makes CSV a format — the leading zeros in a requisition id are still
lost, which is the concession this decision started from.

**Amended — the envelope check refused files older than itself.** It tested
`!==`, contradicting this entry's own reasoning: the whole point of versioning
the envelope apart from the records is that an importer can take a file older
than it is. On the first bump that check would have orphaned every backup already
on disk — for a format whose stated purpose is surviving this extension, with no
retroactive fix available to somebody holding the only copy of their history. It
refuses what it cannot open (`>`), and nothing else.

**Amended — what `lastBackupAt` can honestly claim.** A blob and an `<a
download>` click have no completion signal, and acquiring one means the
`downloads` permission and an install warning (decision 2). So a cancelled
Save-As, or a download a policy blocked, still stamps the date. That matters
because the only consumer is the erase confirmation, where a phantom backup would
silence exactly the warning it exists to raise. The resolution is not to pretend:
what is recorded is that a file was *offered*, and the dialog names the date and
asks the user to check the file is still there rather than asserting a restore is
possible. **A value that cannot be verified should be worded as what it actually
observed.**

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
closed tab is forgotten on `chrome.tabs.onRemoved`.

Every read-modify-write of it is serialized through a promise chain. A read and
the write that depends on it are two turns of the event loop, and the worker is
free to service another message in the gap — so two tabs reporting at once, which
is what middle-clicking two postings from a search page produces, would leave the
second write landing on a cache snapshot taken before the first. One tab's
detection disappears, and the panel reports "no posting detected" for a page its
content script parsed perfectly, with nothing in any console. This is the same
class of bug as decision 9's half-migrated read: an async gap in a component that
looks single-threaded because the language is.

Reports are validated on
arrival — not because the sender is untrusted, since only this extension's own
content scripts can reach `onMessage`, but because everything *inside* the
message came off a web page and a page is free to put a megabyte in its
`<title>`. Content scripts are restricted to the one message they need, so
`posting/delete` is not an ambient capability sitting in a context that runs
inside arbitrary markup.

The snapshot write is allowed to fail without failing the save. Decision 6 exists
to make a future re-parse possible, and losing that is not a reason to lose the
application the user just filed.

**Amended — a detection has to be invalidated, not merely replaced.** Phase 5
made the panel follow tabs live, and the push half did not change, as expected.
What did change is the cost of a cached detection outliving its page. In phase 4
that meant a banner offering a page the user had left, which could be ignored;
once a pristine form fills itself it means the previous job appearing in the form
on an unrelated site, silently, looking exactly like a correct read.

So the worker drops a tab's detection on `chrome.tabs.onUpdated` when
`changeInfo.status === 'loading'` — a real page load. Single-page navigation does
not set it and must not: the boards that change the URL without a load are
already re-reported by the content script's URL watcher, and clearing on those
would delete a detection about to be replaced by an identical one. No permission
is involved; without `tabs`, `onUpdated` still fires and still carries `status`,
and it is `url`, `title` and `favIconUrl` that are withheld.

That listener is global in a way `onRemoved` is not — it fires on every
navigation in every tab, so an ordinary browsing session would wake the worker on
each page load, and decision 9 rests on the worker being idle enough to be torn
down. Everything after the cache delete is therefore gated on the delete having
found something, which makes an uninteresting navigation cost one session-storage
read and stop.

**Revisit when.** If the session cache ever proves too small for how people
actually browse, raise the bound before moving the snapshot anywhere more durable
— it is page-derived data and it should not outlive the browser session.

---

## 16. The worker speaks first, and marks the tab itself

**Decision.** The worker has a one-way event channel to the panel, discriminated
on `type` rather than on the request protocol's `kind`. It announces
`detection/changed` for a tab whenever that tab's detection is reported,
re-reported, superseded or dropped. It also paints the tab's badge itself, from
the same detection-to-posting mapping the panel's revisit banner uses.

**Why.** Decision 15's protocol runs panel-to-worker, and nothing in it lets the
worker speak. That was sufficient while filling was a button: the panel asked on
mount and on focus, and a content script that finished parsing in between was
simply not noticed until the next focus. A panel that follows the tab has to hear
about a report that lands *while it is open* — a board that rendered late, a
single-page navigation, a page read by gesture — and there is no way to hear it
without the worker initiating.

Separating `type` from `kind` is not decoration. The worker's own `onMessage`
listener treats anything carrying a `kind` as a request and hands it to a
dispatcher that throws on an unknown one, so a different key makes an event
structurally incapable of being mistaken for a request in either direction. That
`chrome.runtime.sendMessage` does not currently deliver to the sender's own
context is a runtime detail; this is a type.

**Consequences.** `broadcast` swallows its rejection, and that is the ordinary
path rather than the exceptional one: with the panel closed there is no receiver
and `sendMessage` rejects, which is most of the time. Letting it propagate would
fill the worker's console with a failure meaning "working as intended" and abort
the detection path that called it.

The badge is scoped per tab, which is what makes it correct with no bookkeeping —
Chrome shows the right answer on tab switch with nothing to repaint, and a closed
tab takes its badge with it. A global badge would need every switch to repaint it
and would be wrong in the gap.

The panel does **not** filter events by their `tabId`. Doing so would mean the
panel keeping its own idea of which tab is active, and that second copy is exactly
the thing that goes stale; it re-asks Chrome instead, which is the answer rather
than a cache of it.

One mapping serves both the badge and the revisit banner
(`lib/tracked.ts`). Two would be two definitions of what makes a detection the
same posting as a record, and they would drift.

Whether a tab is tracked is **asked** when a page is detected and **stated** when
a record is written. Re-deriving it after a save was wrong rather than merely
wasteful: the query is built from the cached detection, so it asks about the
page, while the record the user saved is whatever they left in the form — and the
URL field is optional and company names are exactly the sort of thing people tidy.
Clear one and correct the other and the page-shaped query matches nothing, so the
badge stayed dark on a tab the save itself had just tracked.

**Revisit when.** A second kind of event is needed. The union in `lib/events.ts`
is built to grow, but every addition is a thing the panel must decide whether to
act on, and "refresh everything" stops being the right answer once events mean
different things.

---

## 17. The dashboard is a tab, and it finds itself without `tabs`

**Decision.** The dashboard is a full extension page opened in its own tab, not a
view inside the side panel. The panel links to it, and the link focuses the tab
already open rather than opening another. Finding that tab uses a tab id the
dashboard registers about itself in `chrome.storage.session` — not
`chrome.tabs.query`.

**Why.** The panel is about 360px wide. A status funnel, a twelve-column timeline
and a per-board table do not fit in it, and decision 4 already assumed a
dashboard that "may be open in several tabs at once", which is not something a
side panel can be. Opening a tab and focusing a tab are both permission-free, so
the surface costs nothing against decision 2's posture.

The lookup is where the cost hides. `chrome.tabs.query({ url })` is the obvious
way to find an existing dashboard, and its `url` filter is **silently ignored**
unless the extension holds `tabs` or a host permission matching it — the query
resolves to an empty array, which is indistinguishable from "no dashboard open".
The manifest holds neither and decision 2 says it should not start. So the
failure would not be a refusal; it would be a link that opened a new tab every
time it was clicked, each one holding its own `liveQuery` over the whole record
set.

What needs no permission is `tabs.getCurrent()`, which an extension page may
always call about itself, and `tabs.update(id, …)`, which is not gated at all.
So the dashboard registers its own id on load and the panel focuses it.

**Consequences.** `chrome.storage.session` is the right home for the id and
`local` would be wrong: a tab id is meaningless once the browser restarts, and
this is the same scoping the detection cache uses (decision 15). A stale id is
ordinary rather than exceptional — the user closed the tab — and `tabs.update`
rejecting on it is the signal to open a fresh one, not an error worth reporting.

The link is a `<button>` styled as a link, not an `<a href>`. An anchor inside the
side panel navigates the panel itself, which has no back button.

**Amended — the tab is registered by whoever opens it, not only by itself.**
Review found the invariant above held in the steady state and not during
warm-up. Registration originally happened once, in the new tab's own
`main.tsx`, which runs after the bundle has loaded and React has mounted; until
then session storage still read empty, so a second click — an impatient
re-click, most likely — read the same nothing the first one did and opened
another tab. The failure this decision exists to prevent, reached by a different
route.

Two changes close it. `openDashboard` registers the id `tabs.create` hands back,
which is known immediately, and a module-scope in-flight promise makes
concurrent calls share one attempt rather than each running the check-then-create
across two awaits. The tab still announces itself, now as the backstop rather
than the main path: it covers a tab Chrome restored across a browser restart,
whose id nobody recorded because session storage was cleared underneath it.

The general shape is worth naming alongside phase 6's, because it is the same
family: **a check-then-act spanning an await is a race unless something holds the
gap.** Phase 6 found it as a uniqueness check that read before the loop and so
tested a batch against the past rather than against itself; here it is a lookup
that read before a create.

**Revisit when.** The extension needs `tabs` for some other reason, at which
point `tabs.query` becomes the simpler implementation and this bookkeeping can
go. Adding the permission *for* this would be the wrong trade — it is a
broad-reading permission bought to save twenty lines.

---

## 18. What happened after applying is two fields, not more states

**Decision.** `state` keeps its two values (decision 8). What the employer did is
recorded on two further fields: `stage`, the furthest point the application
reached, and `outcome`, how it ended. Neither is ever a value on `state`.

**Why.** They answer different questions. `state` is about the *user* — did you
send it — and decision 8 is emphatic that it must not be inferred from anything.
`stage` and `outcome` are about the *employer*, and folding them into one enum
loses information that cannot be reconstructed.

The case that settles it is the commonest real result in a job search: **rejected
after two interviews**. A single ladder — `viewed | applied | interviewing |
rejected | …` — can say one of those things. Such a record would show as
`rejected` and drop out of the interview count the moment the rejection arrived,
silently understating the interview rate, which is one of the two numbers
somebody opens a dashboard to find. That is the shape `ROADMAP.md` has been
counting since phase 3 under "a claim that outruns what is true", reached here
through a schema choice rather than a rendering one.

Two axes also fail better as they grow. A fourth outcome added to a linear enum
changes what every existing query means; a fourth value on an axis does not.

**Consequences.**

*"No response" is not a value, and that is the point.* It is `stage === null &&
outcome === null`, and how long the silence has lasted is derived from
`appliedAt`. A field the user has to maintain by hand to stay true will be wrong
within a week — nobody returns to a record to tick "still no reply" — whereas a
value derived from a timestamp is correct whenever it is read. `silence()` is the
only view in phase 8 that needed no new field at all, and that is a feature of
the model rather than a coincidence.

*Two axes admit combinations, and most of them are real.* Only two cannot mean
anything, and `resolveProgress` settles those at the single writer (decision 4):
a posting never applied to carries neither field, and an accepted offer implies
the offer stage. Everything else is left exactly as sent — in particular
`outcome: 'rejected'` with `stage: null`, which is not a contradiction but the
ordinary case of being turned down without ever reaching a screen. Flooring it
would invent a conversation that did not happen.

*`stage` is monotonic, so the funnel is a funnel.* Each row is a subset of the one
above it and the counts can only fall, by construction rather than by luck. That
is what makes it honest to draw as a taper where the `viewed`/`applied` funnel —
two exclusive states, not successive ones — is not.

*"Heard back" is asked positively.* `heardBack` tests "reached at least the first
stage", not `stage !== null`, and a rejection counts because a rejection is an
answer while withdrawing is not. The positive form is also the safe one: a
malformed record answers false, where the negative test answers true and inflates
the rate. Wrong low is recoverable; wrong high reads as good news.

*A nullable field still ships with a migration.* Records written at version 2
read back with these properties absent, and `undefined` is not `null` in the CSV
writer, the export validator, or anything that round-trips a record. Schema
version 3 backfills them so the table is one shape. Neither field is indexed, so
there is no Dexie structural upgrade and the dashboard's schema-less reader is
unaffected (decision 4, amended) — pinned by a test, because the next release
that *does* add an index needs to notice.

**Revisit when.** A third axis is genuinely needed — an interview *count*, or
per-round dates, are the plausible ones — or when the external tracker of
decision 7 settles and wants to write outcomes in from email. Adding a value to
either existing axis is an ordinary change and needs no revisit; adding a value
to `state` needs decision 8, not this entry.
