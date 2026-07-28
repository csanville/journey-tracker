import type { JourneyTrackerDb } from './db'
import { now } from './ids'
import { normalizePostingInput } from './normalize'
import { isUsableUrlKey } from './normalize/url'
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
  raw: PostingInput,
): Promise<Posting> {
  // Derived here rather than by the caller, so the join keys cannot drift
  // between whoever happens to be writing. Done before the comparison below so
  // a caller that sends stale keys with otherwise identical content is still
  // recognised as a retry.
  const input = normalizePostingInput(raw)

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
 * Finds an existing record for the same posting, or `null`.
 *
 * Two keys, tried in order (decision 7):
 *
 * 1. **Canonical URL**, when it is a real URL. Direct and unambiguous once
 *    tracking noise is stripped.
 * 2. **Normalized company plus requisition id.** For the same posting reached
 *    through a different route — an aggregator, an embedded board, a shortened
 *    link — where the URLs never converge.
 *
 * Job title is deliberately *not* in the second key, though an earlier plan had
 * it there. A requisition id is already unique within a company, so the title
 * adds no discriminating power; all it adds is a way for the match to fail when
 * a board rewords its own listing. Every field in a join key is a chance to miss.
 *
 * The second key is skipped entirely unless both parts are present. Falling back
 * to company alone would merge every posting at that employer, which is the
 * silent-corruption failure the whole normalization layer is arranged to avoid.
 *
 * This reports; it does not merge. What to do about a duplicate is the form's
 * decision in phase 3, not the repository's.
 */
export async function findDuplicate(
  db: JourneyTrackerDb,
  raw: PostingInput,
): Promise<Posting | null> {
  const input = normalizePostingInput(raw)

  if (isUsableUrlKey(input.canonicalUrl)) {
    // Excluded inside the query rather than after it. Taking the first hit and
    // then discarding it for being the record itself would stop the search
    // early and miss a real duplicate sitting behind it — and would make the
    // answer depend on which of the two records was asked about.
    const byUrl = await db.postings
      .where('canonicalUrl')
      .equals(input.canonicalUrl)
      .filter((p) => p.id !== input.id)
      .first()

    if (byUrl) return byUrl
  }

  if (!input.atsReqId || !input.companyNormalized) return null

  // Indexed on company, then filtered on the requisition. The compound index
  // cannot serve this directly — it carries `jobTitle` in the middle — and the
  // number of records at any one employer is small enough that it does not
  // matter.
  const sameCompany = await db.postings
    .where('companyNormalized')
    .equals(input.companyNormalized)
    .toArray()

  return sameCompany.find((p) => p.id !== input.id && p.atsReqId === input.atsReqId) ?? null
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
