import type { JourneyTrackerDb } from './db'
import type { Request, RequestKind, Response, Result, StatusReport } from './messages'
import * as repo from './repository'
import { readSettings } from './settings'
import { SCHEMA_VERSION } from './types'

/**
 * Request dispatch, kept out of the service worker itself so it can be tested
 * without a browser. The worker file stays thin enough to read in one go.
 */
export async function handleRequest<K extends RequestKind>(
  db: JourneyTrackerDb,
  request: Request<K>,
): Promise<Response<K>> {
  try {
    const data = (await dispatch(db, request as Request)) as Result<K>
    return { ok: true, data }
  } catch (error) {
    // The panel gets a message, the console gets the stack. Nothing leaves the
    // machine either way (decision 1).
    console.error('[JourneyTracker] request failed', request.kind, error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function dispatch(db: JourneyTrackerDb, request: Request): Promise<unknown> {
  switch (request.kind) {
    case 'posting/upsert':
      return repo.upsertPosting(db, request.posting)
    case 'posting/get':
      return repo.getPosting(db, request.id)
    case 'posting/list':
      return repo.listPostings(db)
    case 'posting/count':
      return repo.countPostings(db)
    case 'posting/delete':
      await repo.deletePosting(db, request.id)
      return { deleted: request.id }
    case 'snapshot/put':
      await repo.putSnapshot(db, request.snapshot)
      return { postingId: request.snapshot.postingId }
    case 'snapshot/get':
      return repo.getSnapshot(db, request.postingId)
    case 'status':
      return status(db)
    default: {
      // Exhaustiveness: adding a request kind without a case fails the build.
      const exhaustive: never = request
      throw new Error(`unhandled request: ${JSON.stringify(exhaustive)}`)
    }
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
  }
}
