import type { JourneyTrackerDb } from './db'
import { now } from './ids'
import { POSTING_INPUT_FIELDS, SCHEMA_VERSION } from './types'
import type { Posting, PostingInput, Snapshot } from './types'

/**
 * The only write path. Content scripts cannot reach the extension's IndexedDB
 * at all, and the panel deliberately does not — every mutation arrives here
 * through the service worker so dedupe, schema version and normalization
 * invariants are enforced in exactly one place (decision 4).
 */

/** True when a stored record already matches the input on every caller-owned field. */
function unchanged(existing: Posting, input: PostingInput): boolean {
  return POSTING_INPUT_FIELDS.every(
    (field) => JSON.stringify(existing[field]) === JSON.stringify(input[field]),
  )
}

/**
 * Writes a posting, keyed by the caller-supplied id.
 *
 * Idempotent in the strong sense: re-sending an identical input returns the
 * stored record untouched, leaving even `updatedAt` alone. That matters because
 * an MV3 worker can die after committing but before responding, so the client
 * retries writes it cannot confirm — and a retry must not look like an edit.
 */
export async function upsertPosting(
  db: JourneyTrackerDb,
  input: PostingInput,
): Promise<Posting> {
  return db.transaction('rw', db.postings, async () => {
    const existing = await db.postings.get(input.id)

    if (existing && unchanged(existing, input)) return existing

    const timestamp = now()
    const record: Posting = {
      ...input,
      schemaVersion: SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? input.createdAt ?? timestamp,
      updatedAt: timestamp,
    }

    await db.postings.put(record)
    return record
  })
}

export async function getPosting(
  db: JourneyTrackerDb,
  id: string,
): Promise<Posting | null> {
  return (await db.postings.get(id)) ?? null
}

/** Newest first. Ordering lives here so every caller agrees on it. */
export async function listPostings(db: JourneyTrackerDb): Promise<Posting[]> {
  return db.postings.orderBy('updatedAt').reverse().toArray()
}

export async function countPostings(db: JourneyTrackerDb): Promise<number> {
  return db.postings.count()
}

/**
 * Deletes a posting and any snapshot taken of it, so dropping a record cannot
 * strand the much larger blob behind it.
 */
export async function deletePosting(db: JourneyTrackerDb, id: string): Promise<void> {
  await db.transaction('rw', db.postings, db.snapshots, async () => {
    await db.postings.delete(id)
    await db.snapshots.delete(id)
  })
}

/**
 * One snapshot per posting — a re-capture replaces the previous one. Keeping
 * every historical capture would grow without bound for no benefit; the reason
 * to keep raw source is re-parsing the *current* posting after a parser fix
 * (decision 6).
 */
export async function putSnapshot(
  db: JourneyTrackerDb,
  snapshot: Snapshot,
): Promise<void> {
  await db.snapshots.put(snapshot)
}

export async function getSnapshot(
  db: JourneyTrackerDb,
  postingId: string,
): Promise<Snapshot | null> {
  return (await db.snapshots.get(postingId)) ?? null
}
