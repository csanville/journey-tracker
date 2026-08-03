import type { JourneyTrackerDb } from './db'
import {
  findSnapshot,
  findTabForDetection,
  getDetectionSummary,
  recordDetection,
  sanitizeReport,
} from './detection'
import { broadcast } from './events'
import type { Request, RequestKind, Response, Result, StatusReport } from './messages'
import { recordStorageProtection } from './persistence'
import * as repo from './repository'
import { readSettings } from './settings'
import { postingInputFromDetection, setTrackedBadge } from './tracked'
import { SCHEMA_VERSION } from './types'

/**
 * Who sent the request, as far as the worker can tell for itself.
 *
 * Only `tabId` today, and it comes from Chrome's `sender`, not the payload — a
 * content script cannot claim to be a tab it is not in. It is a separate
 * argument rather than part of the request so the protocol stays a description
 * of what is being asked, not of who is asking.
 */
export interface RequestContext {
  tabId?: number
}

/**
 * Request dispatch, kept out of the service worker itself so it can be tested
 * without a browser. The worker file stays thin enough to read in one go.
 */
export async function handleRequest<K extends RequestKind>(
  db: JourneyTrackerDb,
  request: Request<K>,
  context: RequestContext = {},
): Promise<Response<K>> {
  try {
    const data = (await dispatch(db, request as Request, context)) as Result<K>
    return { ok: true, data }
  } catch (error) {
    // The panel gets a message, the console gets the stack. Nothing leaves the
    // machine either way (decision 1).
    console.error('[JourneyTracker] request failed', request.kind, error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function dispatch(
  db: JourneyTrackerDb,
  request: Request,
  context: RequestContext,
): Promise<unknown> {
  switch (request.kind) {
    case 'posting/upsert':
      return upsert(db, request.posting, request.detectionId)
    case 'posting/get':
      return repo.getPosting(db, request.id)
    case 'posting/list':
      return repo.listPostings(db)
    case 'posting/count':
      return repo.countPostings(db)
    case 'posting/find-duplicate':
      return repo.findDuplicate(db, request.posting)
    case 'posting/delete':
      await repo.deletePosting(db, request.id)
      return { deleted: request.id }
    case 'snapshot/put':
      await repo.putSnapshot(db, request.snapshot)
      return { postingId: request.snapshot.postingId }
    case 'snapshot/get':
      return repo.getSnapshot(db, request.postingId)
    case 'detection/report': {
      // No tab means this did not come from a content script, and a detection
      // that is not attached to a tab is one the panel could never ask for.
      if (context.tabId === undefined) return null

      const report = sanitizeReport(request.report)
      if (!report) return null

      await recordDetection(context.tabId, report)

      // Both of these are about a tab, not about this request, so neither is
      // allowed to fail it. The content script's report is already cached and
      // correct by this point; a badge that did not paint or a panel that did
      // not hear is a worse answer, not a wrong one.
      await announceDetection(db, context.tabId)

      return { detectionId: report.detectionId }
    }
    case 'detection/get':
      return getDetectionSummary(request.tabId)
    case 'status':
      return status(db)
    case 'storage/reassess':
      await recordStorageProtection()
      return status(db)
    default: {
      // Exhaustiveness: adding a request kind without a case fails the build.
      const exhaustive: never = request
      throw new Error(`unhandled request: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Repaints a tab's badge and tells the panel something moved.
 *
 * `tracked` is the answer when the caller already has one. A page that has just
 * been detected has to be *asked* about — that is the query below. A page a
 * record was just written from does not: it is tracked because the write that
 * just succeeded is what tracked it.
 *
 * Re-deriving it in that second case was wrong rather than merely wasteful. The
 * query is built from the cached detection, so it asks about the *page*, while
 * the record the user actually saved is whatever they left in the form — and the
 * URL field is documented as optional, the company is exactly the sort of thing
 * people tidy ("Acme Inc." to "Acme"). Clear one and correct the other and the
 * page-shaped query matches nothing, so the badge stayed dark on a tab that was
 * tracked by the very save that asked.
 *
 * Swallows its own failures. Every caller has already done the thing that
 * mattered — cached a detection, written a record — and neither the badge nor
 * the broadcast is worth turning a completed write into a reported error. The
 * `chrome.action` surface is also the one part of this that is absent in a
 * worker with no toolbar, which is what tests run against.
 */
async function announceDetection(
  db: JourneyTrackerDb,
  tabId: number,
  tracked?: boolean,
): Promise<void> {
  try {
    await setTrackedBadge(tabId, tracked ?? (await isTracked(db, tabId)))
  } catch (error) {
    console.error('[JourneyTracker] could not mark the tab', tabId, error)
  }

  await broadcast({ type: 'detection/changed', tabId })
}

/** Whether what a tab is showing is already in the database. */
async function isTracked(db: JourneyTrackerDb, tabId: number): Promise<boolean> {
  const detection = await getDetectionSummary(tabId)
  if (!detection) return false

  return (await repo.findDuplicate(db, postingInputFromDetection(detection))) !== null
}

/**
 * Writes the posting, then the snapshot of the page it was filled from.
 *
 * Ordered that way because the snapshot is the optional half: a record with no
 * snapshot is a working record, while a snapshot with no record is an orphan.
 * The snapshot write is also allowed to fail without failing the save —
 * decision 6 exists to make a future re-parse possible, and losing that is not
 * a reason to lose the application the user just filed.
 *
 * A `detectionId` that is no longer cached writes nothing, and that is correct
 * rather than a miss. It means the tab has navigated on since the form was
 * filled, so the only snapshot available is of a different page.
 */
async function upsert(
  db: JourneyTrackerDb,
  input: Parameters<typeof repo.upsertPosting>[1],
  detectionId?: string,
): Promise<unknown> {
  const posting = await repo.upsertPosting(db, input)
  if (!detectionId) return posting

  // The page this came from is now tracked, so its tab has a badge to light.
  // Stated rather than asked: the write above is what made it true.
  const tabId = await findTabForDetection(detectionId)
  if (tabId !== null) await announceDetection(db, tabId, true)

  try {
    const detection = await findSnapshot(detectionId)
    if (detection?.snapshot.trimmedSource) {
      await repo.putSnapshot(db, {
        postingId: posting.id,
        capturedAt: detection.capturedAt,
        adapterVersion: detection.adapterVersion,
        trimmedSource: detection.snapshot.trimmedSource,
        truncated: detection.snapshot.truncated,
      })
    }
  } catch (error) {
    console.error('[JourneyTracker] could not store the snapshot', error)
  }

  return posting
}

async function status(db: JourneyTrackerDb): Promise<StatusReport> {
  const settings = await readSettings()
  return {
    schemaVersion: SCHEMA_VERSION,
    dataVersion: settings.dataVersion,
    migrationInProgress: settings.migrationInProgress,
    storagePersisted: settings.storagePersisted,
    storageUnlimited: settings.storageUnlimited,
    evictionSafe: Boolean(settings.storageUnlimited || settings.storagePersisted),
    postingCount: await repo.countPostings(db),
  }
}
