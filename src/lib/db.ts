import Dexie, { type Table } from 'dexie'
import type { Posting, Snapshot } from './types'

export const DB_NAME = 'journeytracker'

/**
 * Postings and snapshots are separate object stores on purpose: snapshots are
 * far larger than the records and are never read during dashboard aggregation,
 * so keeping them apart stops every query dragging megabytes through memory it
 * does not look at (decision 3).
 *
 * Note the distinction between Dexie's own `version().stores()` upgrades, which
 * restructure the database, and the data migrations in `migrations.ts`, which
 * rewrite record contents. Adding an index belongs here; backfilling a field
 * belongs there.
 */
export class JourneyTrackerDb extends Dexie {
  postings!: Table<Posting, string>
  snapshots!: Table<Snapshot, string>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(1).stores({
      // The compound index is the dedupe fallback for when a canonical URL is
      // unavailable or differs across routes to the same posting.
      postings:
        'id, canonicalUrl, companyNormalized, state, updatedAt, [companyNormalized+jobTitle+atsReqId]',
      snapshots: 'postingId, capturedAt',
    })
  }
}

/**
 * Opening is separate from construction so callers can await readiness — the
 * service worker gates every request on it, since the worker may be restarted
 * at any moment and cannot rely on `onInstalled` having run in this lifetime.
 */
export async function openDb(name: string = DB_NAME): Promise<JourneyTrackerDb> {
  const db = new JourneyTrackerDb(name)
  await db.open()
  return db
}
