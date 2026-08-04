import type { JourneyTrackerDb } from './db'
import { now } from './ids'
import { deriveJoinKeys, normalizePostingInput } from './normalize'
import { normalizeTitle } from './normalize/title'
import { isUsableUrlKey, urlHost } from './normalize/url'
import { POSTING_INPUT_FIELDS, SCHEMA_VERSION } from './types'
import type {
  DuplicateMatch,
  NormalizedPostingInput,
  Posting,
  PostingInput,
  Snapshot,
} from './types'

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
    (p) => normalizeTitle(p.jobTitle) === title && !settledAsDifferent(p, input),
  )

  return byTitle ? { posting: byTitle, matchedOn: 'title' } : null
}

/**
 * Whether two same-titled records at one employer are known to be different
 * postings, making the title resemblance irrelevant.
 *
 * Two cases qualify, and the difference between them is the whole point:
 *
 * - **Different requisition ids.** A requisition is the ATS's own identity for a
 *   posting and is unique within a tenant, so two that disagree are two
 *   postings. Without this, every role a large employer posts twice would flag
 *   against itself.
 * - **Different URLs on the same host.** One board serving two paths is that
 *   board saying these are two listings.
 *
 * Different URLs on *different* hosts settle nothing, which is why the host
 * comparison is there. The same job routinely appears on LinkedIn, on an
 * aggregator, and on the company's own board under three unrelated URLs — that
 * is the case the title key exists to catch, and treating any URL difference as
 * decisive would throw it away.
 */
function settledAsDifferent(stored: Posting, input: NormalizedPostingInput): boolean {
  if (stored.atsReqId && input.atsReqId && stored.atsReqId !== input.atsReqId) return true

  const storedHost = urlHost(stored.canonicalUrl)
  const inputHost = urlHost(input.canonicalUrl)

  return (
    storedHost !== null &&
    storedHost === inputHost &&
    stored.canonicalUrl !== input.canonicalUrl
  )
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
export async function putSnapshot(db: JourneyTrackerDb, snapshot: Snapshot): Promise<void> {
  await db.snapshots.put(snapshot)
}

export async function getSnapshot(
  db: JourneyTrackerDb,
  postingId: string,
): Promise<Snapshot | null> {
  return (await db.snapshots.get(postingId)) ?? null
}

/**
 * Which postings have a snapshot, so an export can ask for them in batches
 * rather than requesting one for every record and getting mostly nothing.
 */
export async function listSnapshotIds(db: JourneyTrackerDb): Promise<string[]> {
  return (await db.snapshots.orderBy('capturedAt').primaryKeys()) as string[]
}

/** Snapshots by posting id, skipping ids that have none. */
export async function listSnapshots(
  db: JourneyTrackerDb,
  postingIds: string[],
): Promise<Snapshot[]> {
  const found = await db.snapshots.bulkGet(postingIds)
  return found.filter((snapshot): snapshot is Snapshot => snapshot !== undefined)
}

/**
 * How many postings keep their captured page, per decision 6.
 *
 * Snapshots are one-per-posting and replaced on re-capture, so nothing grows
 * without bound *per record* — but a long job search accumulates records, and
 * each carries up to 256KB of page text. Decision 6 named the number and left
 * the sweep unbuilt through phase 5; phase 6 is where it belongs, because
 * export is when the size of all this becomes visible to the user anyway.
 */
export const SNAPSHOT_RETENTION = 500

/**
 * Drops the oldest snapshots beyond the retention cap.
 *
 * **Records are never dropped, only their snapshots.** A posting whose snapshot
 * has been swept still lists, still dedupes, still exports — it has merely lost
 * the ability to be re-parsed after a future adapter fix, which is the one
 * thing decision 6 is willing to trade away under storage pressure.
 *
 * Ordered by `capturedAt` rather than by the posting's `updatedAt`. It is the
 * snapshot's own recency, it is already indexed, and it needs no join — and the
 * two only disagree for a record edited long after its page was read, where
 * keeping the older capture is not obviously better anyway.
 *
 * Cheap on the ordinary path: a count, and then nothing.
 */
export async function pruneSnapshots(
  db: JourneyTrackerDb,
  keep: number = SNAPSHOT_RETENTION,
): Promise<number> {
  return db.transaction('rw', db.snapshots, async () => {
    if ((await db.snapshots.count()) <= keep) return 0

    // Newest first, then skip the ones being kept: what remains is the tail.
    const doomed = (await db.snapshots
      .orderBy('capturedAt')
      .reverse()
      .offset(keep)
      .primaryKeys()) as string[]

    await db.snapshots.bulkDelete(doomed)
    return doomed.length
  })
}

/** What an import batch did, per record, so the UI can be specific about it. */
export interface InsertOutcome {
  imported: string[]
  /** Already present, and therefore left exactly as they were. */
  skipped: string[]
}

export interface PostingInsertOutcome extends InsertOutcome {
  /**
   * The lowest `schemaVersion` actually written, or `null` if nothing was.
   *
   * The caller migrates from here. A backup restored after an upgrade is the
   * ordinary case for this — the file was written by the build the user had,
   * and the records inside it need every migration since (decision 9).
   */
  lowestVersion: number | null
}

/**
 * Writes records that are not already here, and never touches one that is.
 *
 * Skip-on-conflict is decision 14, and the asymmetry behind it is the same one
 * that governs dedupe: a duplicate id is far more likely to be a re-imported
 * backup than a deliberate correction, and overwriting silently destroys
 * whatever the user has done to that record since. A skip is visible in the
 * summary and costs nothing; an overwrite is invisible and costs the record.
 *
 * This is deliberately *not* `upsertPosting`. That path stamps `updatedAt` with
 * the current time, which is right for a save and wrong for a restore — a
 * re-imported history would arrive with every record edited today, in one
 * indistinguishable block, and the "newest first" list would be meaningless
 * ever after. A restore reproduces what was exported, timestamps included,
 * which is what makes export-wipe-import a round trip rather than a copy.
 *
 * The join keys are re-derived all the same. They are derived fields on every
 * other write (decision 4) and a file is the one input that could carry keys
 * some other build computed — or that somebody edited by hand.
 */
export async function insertMissingPostings(
  db: JourneyTrackerDb,
  postings: Posting[],
): Promise<PostingInsertOutcome> {
  return db.transaction('rw', db.postings, async () => {
    const outcome: PostingInsertOutcome = { imported: [], skipped: [], lowestVersion: null }
    if (postings.length === 0) return outcome

    // One lookup for the batch rather than one per record: the read has to
    // happen inside this transaction anyway, and `bulkGet` preserves order.
    const existing = await db.postings.bulkGet(postings.map((posting) => posting.id))
    const fresh: Posting[] = []

    /**
     * Ids claimed earlier in this same batch.
     *
     * Without it the never-overwrite rule held against the database and not
     * against the file: the `bulkGet` above runs before any write, so two
     * records sharing an id both see nothing stored, both are counted as
     * imported, and `bulkPut` keeps whichever came last. One record silently
     * lost, and the summary reporting both as restored — which is precisely the
     * failure decision 14 forbids, arriving from inside the batch instead of
     * from the store.
     *
     * An export cannot produce this, since ids are keys there. A file
     * hand-merged from two machines, or two backups concatenated, can.
     */
    const claimed = new Set<string>()

    postings.forEach((posting, index) => {
      if (existing[index] || claimed.has(posting.id)) {
        outcome.skipped.push(posting.id)
        return
      }

      claimed.add(posting.id)
      fresh.push({ ...posting, ...deriveJoinKeys(posting) })
      outcome.imported.push(posting.id)
      outcome.lowestVersion =
        outcome.lowestVersion === null
          ? posting.schemaVersion
          : Math.min(outcome.lowestVersion, posting.schemaVersion)
    })

    if (fresh.length > 0) await db.postings.bulkPut(fresh)
    return outcome
  })
}

/**
 * The same rule for snapshots, plus one of its own: no orphans.
 *
 * A snapshot whose posting is not here is dropped rather than stored. It could
 * only be read by looking it up by a posting id that does not exist, so keeping
 * it would be storing up to 256KB of page text that nothing can ever reach —
 * and page text is precisely what this project does not keep for no reason
 * (decision 6).
 *
 * A posting that was skipped as already-present may still gain a snapshot it
 * did not have. That is not an overwrite: it adds a re-parse that was not
 * possible before and changes no record.
 */
export async function insertMissingSnapshots(
  db: JourneyTrackerDb,
  snapshots: Snapshot[],
): Promise<InsertOutcome> {
  return db.transaction('rw', db.postings, db.snapshots, async () => {
    const outcome: InsertOutcome = { imported: [], skipped: [] }
    if (snapshots.length === 0) return outcome

    const ids = snapshots.map((snapshot) => snapshot.postingId)
    const [owners, existing] = await Promise.all([
      db.postings.bulkGet(ids),
      db.snapshots.bulkGet(ids),
    ])

    const fresh: Snapshot[] = []
    /** Same intra-batch hole as above, and closed the same way. */
    const claimed = new Set<string>()

    snapshots.forEach((snapshot, index) => {
      if (existing[index] || !owners[index] || claimed.has(snapshot.postingId)) {
        outcome.skipped.push(snapshot.postingId)
        return
      }

      claimed.add(snapshot.postingId)
      fresh.push(snapshot)
      outcome.imported.push(snapshot.postingId)
    })

    if (fresh.length > 0) await db.snapshots.bulkPut(fresh)
    return outcome
  })
}

/**
 * Deletes everything. The only way to empty the database from the UI.
 *
 * It exists because a restore has to be testable by the person relying on it:
 * an export nobody has ever re-imported is a backup nobody knows the shape of,
 * and this is a project whose data lives in exactly one place (decision 1).
 * Wiping and re-importing is how a user finds out their backup is real.
 *
 * Both stores go in one transaction, so there is no window in which the
 * snapshots outlive the records that name them.
 */
export async function wipeAll(
  db: JourneyTrackerDb,
): Promise<{ postings: number; snapshots: number }> {
  return db.transaction('rw', db.postings, db.snapshots, async () => {
    const counts = {
      postings: await db.postings.count(),
      snapshots: await db.snapshots.count(),
    }

    await db.postings.clear()
    await db.snapshots.clear()

    return counts
  })
}

export async function countSnapshots(db: JourneyTrackerDb): Promise<number> {
  return db.snapshots.count()
}

/**
 * How many of these posting ids still have a snapshot.
 *
 * Counted through the index rather than by fetching the rows, because the rows
 * are the reason snapshots live in their own store — up to 256KB each, and this
 * wants a number.
 */
export async function countSnapshotsAmong(
  db: JourneyTrackerDb,
  postingIds: string[],
): Promise<number> {
  if (postingIds.length === 0) return 0
  return db.snapshots.where('postingId').anyOf(postingIds).count()
}
