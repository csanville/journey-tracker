import { validatePosting, validateSnapshot } from './backup/bundle'
import { confirmationTarget } from './confirmation'
import type { JourneyTrackerDb } from './db'
import {
  cachedTabIds,
  findSnapshot,
  findTabForDetection,
  getDetectionSummary,
  getFailedParse,
  recordDetection,
  recordFailedParse,
  sanitizeFailedParse,
  sanitizeReport,
} from './detection'
import { broadcast } from './events'
import { now } from './ids'
import { readPending, recordPending, retirePending } from './pending'
import type {
  ImportBatchResult,
  Request,
  RequestKind,
  Response,
  Result,
  StatusReport,
} from './messages'
import { noteImportedVersion, resumeImportMigration } from './migrations'
import { recordStorageProtection } from './persistence'
import * as repo from './repository'
import { patchSettings, readSettings } from './settings'
import { postingInputFromDetection, setTrackedBadge } from './tracked'
import { SCHEMA_VERSION } from './types'
import type { Posting, Snapshot } from './types'

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
      // The one-record case of what `backup/wipe` does below, and it needs the
      // same treatment for the same reason: a badge is a claim that the page a
      // tab is showing is in the database, and deleting the record makes every
      // badge asserting it false. Nothing else would repaint them — `detection/
      // get` is a pure cache read, so the panel re-reading the active tab does
      // not touch the toolbar, and only a fresh report from a content script
      // would. That means a reload, which is not something the user should have
      // to know to do.
      //
      // No `tracked` argument, unlike the wipe: after one deletion each tab has
      // to be asked again rather than told, because the answer differs per tab.
      await repaintTrackedTabs(db)
      return { deleted: request.id }
    case 'snapshot/put':
      await repo.putSnapshot(db, request.snapshot)
      return { postingId: request.snapshot.postingId }
    case 'snapshot/ids':
      return repo.listSnapshotIds(db)
    case 'snapshot/list':
      return repo.listSnapshots(db, request.postingIds)
    case 'backup/import-postings':
      return importPostings(db, request.postings, request.schemaVersion, request.final)
    case 'backup/import-snapshots':
      return importSnapshots(db, request.snapshots)
    case 'backup/wipe': {
      const wiped = await repo.wipeAll(db)
      // Nothing is tracked any more, and every badge saying otherwise is now a
      // claim about records that no longer exist.
      await repaintTrackedTabs(db, false)
      return wiped
    }
    case 'backup/recorded':
      await patchSettings({ lastBackupAt: now() })
      return status(db)
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
    case 'application/submitted': {
      if (context.tabId === undefined) return { matched: false }

      return { matched: await announceSubmission(db, context.tabId, request.url) }
    }
    case 'submission/pending':
      return readPending()
    case 'submission/retire':
      return { retired: await retirePending(request.postingId) }
    case 'diagnostic/report': {
      // Same rule as `detection/report`: no tab, no owner, nothing the panel
      // could ever ask for.
      if (context.tabId === undefined) return { recorded: false }

      const failed = sanitizeFailedParse(request.report)
      if (!failed) return { recorded: false }

      await recordFailedParse(context.tabId, failed)

      // Announced on the same channel a detection uses. The panel's question is
      // "what happened on this tab", and a blank read is an answer to it — a
      // second event type would be a second thing to subscribe to for one more
      // way of saying the same tab moved.
      await broadcast({ type: 'detection/changed', tabId: context.tabId })

      return { recorded: true }
    }
    case 'detection/get':
      return getDetectionSummary(request.tabId)
    case 'diagnostic/get':
      return getFailedParse(request.tabId)
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

/**
 * Resolves a confirmation page back to the record it confirms, and tells the
 * panel.
 *
 * The join runs **URL-first against the stored records**, never against the
 * detection cache, and that is forced rather than chosen. Decision 15's
 * `onUpdated` listener drops a tab's detection on `status === 'loading'`, and
 * a confirmation page is a real page load — so by the time this runs, the
 * detection for the posting being confirmed is already gone. The worker cannot
 * special-case it either: `changeInfo.url` is withheld without the `tabs`
 * permission decision 2 keeps out of the manifest.
 *
 * `confirmationTarget` is re-run here rather than trusting the derived URL the
 * content script could have sent. The content script's filtering keeps ordinary
 * navigation from costing a message; deciding that somebody applied to
 * something is the worker's call.
 *
 * Nothing is written. Decision 12 is explicit that detection prompts rather
 * than writes, and this respects it in the strong sense — no record changes
 * until the user answers, so a wrong match costs one dismissed prompt.
 *
 * Silent by design in two cases, both of which are the right answer:
 *
 * - **No record for the page.** The user applied without ever saving it, and
 *   manufacturing a posting from a confirmation page — which carries no job
 *   description, employer or title worth trusting — would put a junk record in
 *   a tracker to save one click.
 * - **The record already says `applied`.** There is nothing to ask.
 */
async function announceSubmission(
  db: JourneyTrackerDb,
  tabId: number,
  reportedUrl: string,
): Promise<boolean> {
  const target = confirmationTarget(reportedUrl)
  if (target === null) return false

  const match = await repo.findDuplicate(
    db,
    postingInputFromDetection({ ...BLANK, url: target }),
  )

  // Only an identity match counts. `findDuplicate` will also answer on company
  // and title, which is right for "you may have seen this before" and far too
  // loose for "you applied to this" — and the query carries no company anyway.
  if (!match || match.matchedOn !== 'url') return false
  if (match.posting.state === 'applied') return false

  // Written down before it is announced, and that order is the phase. The
  // broadcast is best-effort by design — `broadcast` swallows the rejection when
  // no panel is listening, which is the ordinary case — so a question that
  // existed only in the event was lost every time somebody applied with the
  // panel closed. Recording first means the announcement is an optimisation: it
  // gets an open panel to ask immediately, and a closed one loses nothing.
  //
  // `Date.now()` here rather than at the click is the other half. This is the
  // moment the confirmation page was seen, and it is what will land on the
  // record however much later the user answers.
  await recordPending(match.posting.id)
  await broadcast({ type: 'submission/pending', tabId })

  return true
}

/** A detection-shaped query carrying nothing but the URL it is asking about. */
const BLANK = {
  fields: {
    company: null,
    jobTitle: null,
    location: null,
    workMode: null,
    atsReqId: null,
    salary: null,
  },
  source: 'confirmation',
  confidence: 0,
  adapterVersion: 'confirmation@1',
} as const

/**
 * Re-answers "is this page tracked" for every tab holding a detection.
 *
 * The badge is painted from a detection-to-record match (decision 16), so it is
 * a claim about the *record set* as much as about the page — and a wipe or a
 * restore moves the record set under every tab at once. Without this, erasing
 * everything left tabs wearing badges asserting records that had just been
 * deleted, contradicting the panel's own revisit banner, which re-queries and
 * would say otherwise; a restore left them dark on pages it had just tracked.
 *
 * Bounded by the detection cache's own eight-tab limit, so this is at most
 * eight lookups however large the import was. `tracked` is passed when the
 * caller already knows — after a wipe nothing is tracked, and asking is both
 * wasteful and, on an empty database, a query that can only return one answer.
 */
async function repaintTrackedTabs(db: JourneyTrackerDb, tracked?: boolean): Promise<void> {
  const tabs = await cachedTabIds()

  // Sequential rather than parallel: each one paints a badge and broadcasts,
  // and there is no deadline here worth racing eight session-storage reads for.
  for (const tabId of tabs) await announceDetection(db, tabId, tracked)
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

      // Decision 6's retention cap, swept where snapshots are actually created.
      // A count and nothing else until the cap is passed, which is several
      // hundred captures away for anyone who has just installed this.
      await repo.pruneSnapshots(db)
    }
  } catch (error) {
    console.error('[JourneyTracker] could not store the snapshot', error)
  }

  return posting
}

/**
 * One batch of records from an export file.
 *
 * Validated again here, and not because the panel is untrusted — it is this
 * extension's own page. It is because everything in the payload came out of a
 * file the user picked, and the worker is the single writer (decision 4): the
 * guarantee that nothing malformed reaches the database has to hold at the
 * place that writes, not at the place that happened to read the file. It is the
 * same reasoning that validates a content script's report on arrival
 * (decision 15), and it costs one pass over an array.
 *
 * A record that fails is dropped from the batch rather than failing it. The
 * panel has already told the user how many the file offered, so a record lost
 * here would show up as a discrepancy in the summary — which is the point.
 */
async function importPostings(
  db: JourneyTrackerDb,
  postings: Posting[],
  schemaVersion: number,
  final: boolean,
): Promise<ImportBatchResult> {
  const valid = postings
    .map(validatePosting)
    .filter((posting): posting is Posting => typeof posting !== 'string')

  const outcome = await repo.insertMissingPostings(db, valid)

  // Gated on what was actually *written*, not on what the file claims. A batch
  // that imported nothing — re-importing a backup already restored — has
  // nothing to migrate, and keying this on the envelope's version instead made
  // an old file rewrite the whole table for every batch of records it did not
  // insert.
  //
  // Recorded now and run at the end. The record survives a worker that dies
  // in between, which is what stops a half-imported old backup sitting at an
  // intermediate version forever.
  const lowest = Math.min(schemaVersion, outcome.lowestVersion ?? SCHEMA_VERSION)
  if (outcome.lowestVersion !== null && lowest < SCHEMA_VERSION) {
    await noteImportedVersion(lowest)
  }

  if (final) {
    const applied = await resumeImportMigration(db)
    if (applied.length > 0) {
      console.info('[JourneyTracker] migrated imported records', applied)
    }

    // Once, at the end, and after any migration — the join keys a restored
    // record matches on are exactly what a migration might have rewritten. A
    // page open in another tab may be tracked now that its record is back.
    await repaintTrackedTabs(db)
  }

  return { imported: outcome.imported.length, skipped: outcome.skipped.length, dropped: 0 }
}

async function importSnapshots(
  db: JourneyTrackerDb,
  snapshots: Snapshot[],
): Promise<ImportBatchResult> {
  const valid = snapshots
    .map(validateSnapshot)
    .filter((snapshot): snapshot is Snapshot => typeof snapshot !== 'string')

  const outcome = await repo.insertMissingSnapshots(db, valid)

  // The restore is subject to the same cap as ordinary capture (decision 6):
  // importing a full backup taken before the sweep existed should not be a way
  // to reinstate a thousand snapshots.
  await repo.pruneSnapshots(db)

  // Counted *after* the sweep, because the sweep may have taken some of what
  // was just written — restoring an old backup into a database of newer
  // captures inserts pages the cap immediately reclaims. Reporting them as
  // imported would claim pages the database does not have, and the number is
  // the only way the user learns the retention cap exists at all.
  const survived = await repo.countSnapshotsAmong(db, outcome.imported)

  return {
    imported: survived,
    skipped: outcome.skipped.length,
    dropped: outcome.imported.length - survived,
  }
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
    snapshotCount: await repo.countSnapshots(db),
    lastBackupAt: settings.lastBackupAt,
  }
}
