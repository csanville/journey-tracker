import type { ExtractedFields, FieldName, Tier } from './extract'
import { FIELD_NAMES, TIER_ORDER } from './extract'
import { SNAPSHOT_CAP_BYTES } from './extract/snapshot'
import type { Salary, SalaryPeriod, WorkMode } from './types'

/**
 * What a content script reports, and where the worker keeps it.
 *
 * The shape of this phase's delivery path, and why it is shaped this way:
 *
 * - The content script **pushes**. The panel cannot pull, because reading a
 *   tab's URL from the extension side needs the `tabs` permission, and the whole
 *   point of decision 2 is not to ask for it. The script reports its own
 *   `location.href` alongside what it parsed.
 * - The worker **caches, keyed by tab**. It is already the single writer
 *   (decision 4) and it is the only context both sides can reach.
 * - The panel receives a **summary without the page source**. The trimmed
 *   snapshot is up to 256KB of page-derived text (decision 6) and the panel has
 *   no use for it; sending it would put it through two message hops and leave it
 *   in a React state tree for no reason.
 * - On save, the panel sends back only the `detectionId`, and the worker writes
 *   the snapshot from its own cache. If the tab has moved on and the id is gone,
 *   no snapshot is written — which is right. A snapshot of a different page,
 *   attached to this record, is worse than no snapshot at all.
 *
 * The cache lives in `chrome.storage.session` rather than a module variable
 * because an MV3 worker is torn down after about 30 seconds idle (decision 9),
 * and the gap between a posting being detected and the user pressing Save is
 * however long it takes to read a job description. In memory, the snapshot would
 * be gone by then, every time, silently — decision 6 defeated by a lifecycle
 * detail. `session` is the right store: it is not persisted to disk, it clears
 * when the browser closes, and it needs no permission beyond the `storage` the
 * manifest already declares.
 */

const CACHE_KEY = 'detections'

/**
 * How many tabs to remember at once.
 *
 * `chrome.storage.session` has a 10MB budget and a snapshot is capped at 256KB,
 * so eight is comfortably inside it with room for the summaries. The bound
 * exists at all because a user with forty job tabs open is not unusual and an
 * unbounded cache would fill the budget and start failing writes — silently, in
 * the worker, where nobody would see it.
 */
export const MAX_CACHED_TABS = 8

export interface DetectionSnapshot {
  trimmedSource: string
  truncated: boolean
}

/** What the content script sends. Everything in it is page-derived. */
export interface DetectionReport {
  detectionId: string
  url: string
  source: string
  adapterVersion: string
  confidence: number
  fields: ExtractedFields
  provenance: Record<FieldName, Tier | null>
  snapshot: DetectionSnapshot
}

/** What the worker stores, plus its own trusted timestamp. */
export interface CachedDetection extends DetectionReport {
  capturedAt: number
}

/** What the panel gets: everything except the page source. */
export type DetectionSummary = Omit<CachedDetection, 'snapshot'> & {
  /** So the panel can say a snapshot was kept without holding it. */
  snapshotBytes: number
}

type Cache = Record<string, CachedDetection>

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The guard on the way in.
 *
 * Not because the sender is untrusted — only this extension's own content
 * scripts can reach `chrome.runtime.onMessage`, and they only run on the hosts
 * the manifest names. It is because everything *inside* the message came off a
 * web page, and a page is free to be arbitrary. The two things that actually go
 * wrong are size (a `<title>` element containing a megabyte, filling the session
 * budget) and shape (a `workMode` of `"probably"` reaching a typed record). Both
 * are cheap to rule out here and awkward to notice later.
 */

const MAX_TEXT = 300
const MAX_ID = 128
const MAX_URL = 4096

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

const WORK_MODES: readonly WorkMode[] = ['onsite', 'hybrid', 'remote']
const PERIODS: readonly SalaryPeriod[] = ['hour', 'day', 'week', 'month', 'year']

function salary(value: unknown): Salary | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>

  const period = PERIODS.find((candidate) => candidate === raw.period) ?? null
  const min = finite(raw.min, 0, Number.MAX_SAFE_INTEGER)
  const max = finite(raw.max, 0, Number.MAX_SAFE_INTEGER)
  const rawText = text(raw.raw)

  if (min === null && max === null && rawText === null) return null

  return {
    min,
    max,
    currency: text(raw.currency, 8),
    period,
    raw: rawText,
  }
}

function fields(value: unknown): ExtractedFields {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >

  return {
    company: text(raw.company),
    jobTitle: text(raw.jobTitle),
    location: text(raw.location),
    workMode: WORK_MODES.find((mode) => mode === raw.workMode) ?? null,
    atsReqId: text(raw.atsReqId, 128),
    salary: salary(raw.salary),
  }
}

function provenance(value: unknown): Record<FieldName, Tier | null> {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >

  return Object.fromEntries(
    FIELD_NAMES.map((name) => [
      name,
      TIER_ORDER.find((tier) => tier === raw[name]) ?? null,
    ]),
  ) as Record<FieldName, Tier | null>
}

function snapshot(value: unknown): DetectionSnapshot {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >
  const source = typeof raw.trimmedSource === 'string' ? raw.trimmedSource : ''

  // The content script caps this already; re-checking here is the difference
  // between a cap and a wish. Measured in UTF-16 units against a byte cap, so
  // this can only ever be stricter than the real limit.
  return {
    trimmedSource: source.length <= SNAPSHOT_CAP_BYTES ? source : '',
    truncated: raw.truncated === true || source.length > SNAPSHOT_CAP_BYTES,
  }
}

/**
 * Validates a reported detection, or returns `null` if it is not one.
 *
 * A report with neither a company nor a title is rejected outright: it would
 * offer the user a fill button that fills nothing.
 */
export function sanitizeReport(value: unknown): DetectionReport | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>

  const detectionId = text(raw.detectionId, MAX_ID)
  const url = text(raw.url, MAX_URL)
  const source = text(raw.source, 64)
  const adapterVersion = text(raw.adapterVersion, 64)
  const confidence = finite(raw.confidence, 0, 1)

  if (!detectionId || !url || !source || !adapterVersion || confidence === null) return null

  const parsed = fields(raw.fields)
  if (!parsed.company && !parsed.jobTitle) return null

  return {
    detectionId,
    url,
    source,
    adapterVersion,
    confidence,
    fields: parsed,
    provenance: provenance(raw.provenance),
    snapshot: snapshot(raw.snapshot),
  }
}

/* -------------------------------------------------------------------------- */
/* The cache                                                                   */
/* -------------------------------------------------------------------------- */

async function readCache(): Promise<Cache> {
  const stored = await chrome.storage.session.get(CACHE_KEY)
  const cache = stored[CACHE_KEY]

  return typeof cache === 'object' && cache !== null ? (cache as Cache) : {}
}

async function writeCache(cache: Cache): Promise<void> {
  await chrome.storage.session.set({ [CACHE_KEY]: cache })
}

/**
 * Serializes every read-modify-write of the cache.
 *
 * `chrome.storage` is asynchronous, so a read and the write that depends on it
 * are two turns with a gap between them, and the worker is free to service
 * another message in that gap. Two tabs reporting at once is not a rare
 * interleaving to reason about — it is what happens every time somebody
 * middle-clicks two postings from a search page, because both content scripts
 * fire their first attempt on the same timer. Interleaved, the second write
 * lands on a snapshot of the cache taken before the first, and one tab's
 * detection disappears: the panel says "no posting detected" for a page whose
 * content script parsed it perfectly, with nothing in any console.
 *
 * A promise chain is enough. The worker is single-threaded, so the only
 * concurrency is this — awaits interleaving inside one thread — and queueing
 * the whole read-modify-write behind the previous one removes it. The queue is
 * per-worker-lifetime, which is the same lifetime as the only writer there is
 * (decision 4).
 */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  // The failure of one operation must not poison the queue for the next, so the
  // chain is continued from a settled promise rather than the returned one.
  const result = queue.then(operation, operation)
  queue = result.catch(() => undefined)

  return result
}

export function summarize(detection: CachedDetection): DetectionSummary {
  const { snapshot: kept, ...rest } = detection

  return { ...rest, snapshotBytes: kept.trimmedSource.length }
}

/**
 * Stores a detection against the tab that reported it, evicting the oldest once
 * the cache is full.
 */
export function recordDetection(
  tabId: number,
  report: DetectionReport,
  capturedAt: number = Date.now(),
): Promise<CachedDetection> {
  return serialized(async () => {
    const cache = await readCache()
    const detection: CachedDetection = { ...report, capturedAt }

    cache[String(tabId)] = detection

    const entries = Object.entries(cache)
    if (entries.length > MAX_CACHED_TABS) {
      const survivors = entries
        .sort(([, a], [, b]) => b.capturedAt - a.capturedAt)
        .slice(0, MAX_CACHED_TABS)

      await writeCache(Object.fromEntries(survivors))
      return detection
    }

    await writeCache(cache)
    return detection
  })
}

/** The panel's view of what is on a tab, or `null` if nothing was detected. */
export async function getDetectionSummary(tabId: number): Promise<DetectionSummary | null> {
  const detection = (await readCache())[String(tabId)]

  return detection ? summarize(detection) : null
}

/**
 * Every tab currently holding a detection.
 *
 * Bounded to `MAX_CACHED_TABS`, so iterating it is cheap by construction. It
 * exists for the operations that change the *record set* rather than a single
 * page — a wipe, a restore — after which every badge painted from a detection
 * is a claim that has to be re-checked.
 */
export async function cachedTabIds(): Promise<number[]> {
  return Object.keys(await readCache()).map(Number)
}

/**
 * The snapshot for a detection id, wherever it is cached.
 *
 * Looked up by id rather than by tab because by the time the user saves, the tab
 * may have navigated on and been overwritten by a newer detection. A miss is a
 * correct answer, not a failure: it means the page this record came from is no
 * longer the page that tab is showing, and attaching that tab's current snapshot
 * to this record would be a lie recorded permanently.
 */
export async function findSnapshot(detectionId: string): Promise<CachedDetection | null> {
  const cache = await readCache()

  return (
    Object.values(cache).find((detection) => detection.detectionId === detectionId) ?? null
  )
}

/**
 * Which tab a detection came from, or `null` if none still holds it.
 *
 * Saving a record makes its page tracked, so the tab showing that page has a
 * badge to light — but the panel has no tab of its own and cannot say which one
 * it means. The save already carries a `detectionId` so the worker can attach
 * the snapshot, and the cache is keyed by tab, so the tab is derivable from what
 * is already being sent. A manual save carries no detection and lights nothing,
 * which is right: there is no page it came from.
 */
export async function findTabForDetection(detectionId: string): Promise<number | null> {
  const cache = await readCache()

  const entry = Object.entries(cache).find(
    ([, detection]) => detection.detectionId === detectionId,
  )

  return entry ? Number(entry[0]) : null
}

/**
 * Drops a tab's detection, and says whether there was one to drop.
 *
 * Serialized for the same reason as `recordDetection`, and against a sharper
 * failure: interleaved with a report from another tab, an unqueued delete
 * writes back a cache snapshot taken before that report — resurrecting the
 * closed tab's entry and losing the live one.
 *
 * The return value is what lets `onUpdated` tell an interesting navigation from
 * the overwhelming majority that are not. Only eight tabs are ever cached, and
 * only tabs showing a posting are among them, so "was this tab one of ours" is
 * the cheapest possible filter and it is already answered here.
 */
export function forgetTab(tabId: number): Promise<boolean> {
  return serialized(async () => {
    const cache = await readCache()
    if (!(String(tabId) in cache)) return false

    delete cache[String(tabId)]
    await writeCache(cache)
    return true
  })
}
