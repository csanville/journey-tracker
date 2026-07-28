import type { JourneyTrackerDb } from './db'
import { now } from './ids'
import { normalizePostingInput } from './normalize'
import { normalizeTitle } from './normalize/title'
import { isUsableUrlKey } from './normalize/url'
import { POSTING_INPUT_FIELDS, SCHEMA_VERSION } from './types'
import type { DuplicateMatch, Posting, PostingInput, Snapshot } from './types'

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
 * Finds an existing record that may be the same posting, or `null`.
 *
 * Three keys, strongest first (decision 7):
 *
 * 1. **Canonical URL**, when it is a real URL. Identity, once tracking noise is
 *    stripped.
 * 2. **Normalized company plus requisition id.** Also identity — a requisition
 *    is unique within an ATS tenant — and it catches the same posting reached
 *    through a different route, where the URLs never converge.
 * 3. **Normalized company plus normalized title.** A resemblance rather than an
 *    identity: often the same posting, sometimes two teams hiring the same role.
 *
 * Job title is deliberately absent from key 2. A requisition id is already
 * unique within a company, so adding the title there only gives the match a way
 * to fail when a board rewords its own listing.
 *
 * Key 3 exists because the first two answer "is this the same record" and the
 * user's actual question is "have I been here before". Without it, two hand-
 * entered applications to one employer for one role — no URL, no requisition —
 * sail past each other, which is precisely when a person would expect to be
 * asked.
 *
 * Admitting a fuzzy key is only safe because **this reports and never merges.**
 * The wrong-merge asymmetry that governs the rest of the normalization layer is
 * about silent collapse; here a false positive costs one dismissible prompt. The
 * confidence travels with the answer so the UI can say which it found.
 */
export async function findDuplicate(
  db: JourneyTrackerDb,
  raw: PostingInput,
): Promise<DuplicateMatch | null> {
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

    if (byUrl) return { posting: byUrl, matchedOn: 'url' }
  }

  // Both remaining keys start from the employer. Falling back to company alone
  // would match every posting there, which is why neither is tried without it.
  if (!input.companyNormalized) return null

  // Indexed on company, then filtered in memory. The compound index cannot
  // serve either key — it carries `jobTitle` in the middle — and the number of
  // records at any one employer is small enough that it does not matter.
  const sameCompany = (
    await db.postings.where('companyNormalized').equals(input.companyNormalized).toArray()
  ).filter((p) => p.id !== input.id)

  if (input.atsReqId) {
    const byRequisition = sameCompany.find((p) => p.atsReqId === input.atsReqId)
    if (byRequisition) return { posting: byRequisition, matchedOn: 'requisition' }
  }

  const title = normalizeTitle(input.jobTitle)
  if (!title) return null

  const byTitle = sameCompany.find(
    (p) =>
      normalizeTitle(p.jobTitle) === title &&
      // Two requisitions that are both known and different are definitively
      // different postings, whatever the title says. Without this, every role a
      // large employer posts twice would flag against itself.
      !(p.atsReqId && input.atsReqId && p.atsReqId !== input.atsReqId),
  )

  return byTitle ? { posting: byTitle, matchedOn: 'title' } : null
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
