import { afterEach, describe, expect, it, vi } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import {
  SNAPSHOT_RETENTION,
  countPostings,
  countSnapshotsAmong,
  deletePosting,
  getPosting,
  getSnapshot,
  insertMissingPostings,
  insertMissingSnapshots,
  listPostings,
  listSnapshotIds,
  listSnapshots,
  pruneSnapshots,
  putSnapshot,
  upsertPosting,
  wipeAll,
} from './repository'
import { SCHEMA_VERSION } from './types'
import type { Posting, Snapshot } from './types'

afterEach(() => {
  vi.useRealTimers()
})

describe('postings', () => {
  it('round-trips a record through storage unchanged', async () => {
    const db = await freshDb()
    const input = aPosting()

    const written = await upsertPosting(db, input)
    const read = await getPosting(db, input.id)

    expect(read).toEqual(written)
    // Nested objects have to survive the structured clone intact, not just the
    // scalar fields.
    expect(read?.salary).toEqual(input.salary)
    expect(read?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(read?.createdAt).toBeGreaterThan(0)
  })

  it('returns null for an unknown id rather than throwing', async () => {
    const db = await freshDb()
    expect(await getPosting(db, 'nope')).toBeNull()
  })

  /**
   * The `stage`/`outcome` invariants, asserted through the real write path
   * rather than against `resolveProgress` directly — that function is already
   * covered, and what matters here is that `upsertPosting` actually routes
   * through it. Decision 4 makes this the one place the rule binds.
   */
  it('refuses to store progress on a posting that was only looked at', async () => {
    const db = await freshDb()

    const written = await upsertPosting(
      db,
      aPosting({ state: 'viewed', stage: 'interviewing', outcome: 'rejected' }),
    )

    expect(written.stage).toBeNull()
    expect(written.outcome).toBeNull()
  })

  it('implies the offer stage when an offer was accepted', async () => {
    const db = await freshDb()

    const written = await upsertPosting(
      db,
      aPosting({ state: 'applied', appliedAt: 1_000, stage: null, outcome: 'accepted' }),
    )

    expect(written.stage).toBe('offer')
  })

  it('keeps a rejection that never reached a stage, which is not a contradiction', async () => {
    const db = await freshDb()

    const written = await upsertPosting(
      db,
      aPosting({ state: 'applied', appliedAt: 1_000, stage: null, outcome: 'rejected' }),
    )

    expect(written.stage).toBeNull()
    expect(written.outcome).toBe('rejected')
  })

  /**
   * A resolved record has to come back out of `upsertPosting` unchanged, or the
   * retry that decision 4 relies on stops being a no-op: the client re-sends
   * what it was given, and if resolving it a second time moved anything the
   * write would look like an edit and bump `updatedAt`.
   */
  it('treats a re-sent resolved record as a retry, not an edit', async () => {
    const db = await freshDb()
    const first = await upsertPosting(
      db,
      aPosting({ id: 'retry', state: 'applied', appliedAt: 1_000, outcome: 'accepted' }),
    )

    const second = await upsertPosting(db, first)

    expect(second).toEqual(first)
  })

  it('lists newest first', async () => {
    const db = await freshDb()
    // Two writes inside one millisecond tie on `updatedAt`, which leaves the
    // order undefined and the assertion meaningless. Hold the clock still and
    // step it deliberately instead. Only `Date` is faked — faking timers
    // outright would stall the IndexedDB event loop these writes run on.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const older = await upsertPosting(db, aPosting({ jobTitle: 'Older' }))
    vi.setSystemTime(2_000)
    const newer = await upsertPosting(db, aPosting({ jobTitle: 'Newer' }))

    const listed = await listPostings(db)

    expect(listed).toHaveLength(2)
    expect(listed[0]?.id).toBe(newer.id)
    expect(listed[1]?.id).toBe(older.id)
  })

  describe('idempotency', () => {
    it('does not double-write when an identical request is retried', async () => {
      const db = await freshDb()
      const input = aPosting()

      const first = await upsertPosting(db, input)
      const retry = await upsertPosting(db, input)

      expect(await countPostings(db)).toBe(1)
      // The strong guarantee: a retry is not an edit, so even updatedAt holds
      // still. A client that retries a write it could not confirm must not
      // leave a fingerprint.
      expect(retry).toEqual(first)
      expect(retry.updatedAt).toBe(first.updatedAt)
    })

    it('still records a genuine edit, preserving createdAt', async () => {
      const db = await freshDb()
      const input = aPosting()
      const first = await upsertPosting(db, input)

      const edited = await upsertPosting(db, {
        ...input,
        state: 'applied',
        appliedAt: 1,
        notes: 'Referred by Milton',
      })

      expect(await countPostings(db)).toBe(1)
      expect(edited.state).toBe('applied')
      expect(edited.notes).toBe('Referred by Milton')
      expect(edited.createdAt).toBe(first.createdAt)
      expect(edited.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    })

    it('treats a nested salary change as an edit, not a retry', async () => {
      const db = await freshDb()
      const input = aPosting()
      const first = await upsertPosting(db, input)

      const edited = await upsertPosting(db, {
        ...input,
        salary: { ...input.salary!, max: 240_000 },
      })

      expect(edited.salary?.max).toBe(240_000)
      expect(edited.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    })
  })
})

describe('snapshots', () => {
  it('stores and reads back a snapshot by posting id', async () => {
    const db = await freshDb()
    const posting = await upsertPosting(db, aPosting())

    await putSnapshot(db, {
      postingId: posting.id,
      capturedAt: 1,
      adapterVersion: 'jsonld@1',
      trimmedSource: '<script type="application/ld+json">{}</script>',
      truncated: false,
    })

    expect((await getSnapshot(db, posting.id))?.adapterVersion).toBe('jsonld@1')
  })

  it('replaces rather than accumulates on re-capture', async () => {
    const db = await freshDb()
    const posting = await upsertPosting(db, aPosting())
    const base = {
      postingId: posting.id,
      capturedAt: 1,
      adapterVersion: 'jsonld@1',
      truncated: false,
    }

    await putSnapshot(db, { ...base, trimmedSource: 'first' })
    await putSnapshot(db, { ...base, trimmedSource: 'second' })

    expect(await db.snapshots.count()).toBe(1)
    expect((await getSnapshot(db, posting.id))?.trimmedSource).toBe('second')
  })

  it('deletes the snapshot along with its posting, leaving nothing stranded', async () => {
    const db = await freshDb()
    const posting = await upsertPosting(db, aPosting())
    await putSnapshot(db, {
      postingId: posting.id,
      capturedAt: 1,
      adapterVersion: 'jsonld@1',
      trimmedSource: 'x',
      truncated: false,
    })

    await deletePosting(db, posting.id)

    expect(await getPosting(db, posting.id)).toBeNull()
    expect(await getSnapshot(db, posting.id)).toBeNull()
  })
})

/**
 * The import write path. Deliberately not `upsertPosting`: a restore reproduces
 * what was exported, timestamps and all, where a save stamps the present.
 */
describe('insertMissingPostings', () => {
  it('writes records that are not here and reports which', async () => {
    const db = await freshDb()

    const outcome = await insertMissingPostings(db, [
      aStored({ id: 'a' }),
      aStored({ id: 'b' }),
    ])

    expect(outcome.imported).toEqual(['a', 'b'])
    expect(outcome.skipped).toEqual([])
    expect(await countPostings(db)).toBe(2)
  })

  // Decision 14: a duplicate id is far more likely to be a re-imported backup
  // than a deliberate correction, and overwriting silently destroys whatever
  // the user has done to the record since.
  it('leaves an existing record exactly as it is', async () => {
    const db = await freshDb()
    const existing = await upsertPosting(db, aPosting({ id: 'a', notes: 'mine' }))

    const outcome = await insertMissingPostings(db, [
      aStored({ id: 'a', notes: 'from the file', updatedAt: 1 }),
    ])

    expect(outcome).toMatchObject({ imported: [], skipped: ['a'] })
    expect(await getPosting(db, 'a')).toEqual(existing)
  })

  it('preserves the timestamps the file carried', async () => {
    const db = await freshDb()

    await insertMissingPostings(db, [
      aStored({ id: 'a', createdAt: 1_000, updatedAt: 2_000 }),
    ])

    const stored = await getPosting(db, 'a')
    expect(stored?.createdAt).toBe(1_000)
    expect(stored?.updatedAt).toBe(2_000)
  })

  /**
   * Derived on every other write (decision 4), and a file is the one input that
   * could carry keys computed by another build — or edited by hand.
   */
  it('re-derives the join keys rather than trusting the file', async () => {
    const db = await freshDb()

    await insertMissingPostings(db, [
      aStored({
        id: 'a',
        company: 'Initech Inc.',
        companyNormalized: 'whatever-was-in-the-file',
        url: 'https://boards.greenhouse.io/initech/jobs/9?utm_source=x',
        canonicalUrl: 'nonsense',
      }),
    ])

    const stored = await getPosting(db, 'a')
    expect(stored?.companyNormalized).toBe('initech')
    expect(stored?.canonicalUrl).toBe('https://boards.greenhouse.io/initech/jobs/9')
  })

  it('reports the lowest version written, which is what needs migrating', async () => {
    const db = await freshDb()

    const outcome = await insertMissingPostings(db, [
      aStored({ id: 'a', schemaVersion: 2 }),
      aStored({ id: 'b', schemaVersion: 1 }),
    ])

    expect(outcome.lowestVersion).toBe(1)
  })

  it('reports no version at all when everything was skipped', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting({ id: 'a' }))

    expect(
      (await insertMissingPostings(db, [aStored({ id: 'a' })])).lowestVersion,
    ).toBeNull()
  })
})

describe('insertMissingSnapshots', () => {
  it('adds a page to a record that has none', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting({ id: 'a' }))

    const outcome = await insertMissingSnapshots(db, [aSnapshotFor('a')])

    expect(outcome.imported).toEqual(['a'])
    expect(await getSnapshot(db, 'a')).not.toBeNull()
  })

  it('does not replace a page already captured', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting({ id: 'a' }))
    await putSnapshot(db, { ...aSnapshotFor('a'), trimmedSource: 'the one we have' })

    const outcome = await insertMissingSnapshots(db, [aSnapshotFor('a')])

    expect(outcome.skipped).toEqual(['a'])
    expect((await getSnapshot(db, 'a'))?.trimmedSource).toBe('the one we have')
  })

  /**
   * An orphan could only be read by looking up a posting id that does not
   * exist — up to 256KB of page text nothing can ever reach, which is the one
   * thing decision 6 will not store.
   */
  it('drops a page whose record is not here', async () => {
    const db = await freshDb()

    const outcome = await insertMissingSnapshots(db, [aSnapshotFor('missing')])

    expect(outcome.skipped).toEqual(['missing'])
    expect(await db.snapshots.count()).toBe(0)
  })
})

/** Decision 6's retention cap, unbuilt until phase 6 opened the storage picture. */
describe('pruneSnapshots', () => {
  it('does nothing at all below the cap', async () => {
    const db = await freshDb()
    await putSnapshot(db, aSnapshotFor('a'))

    expect(await pruneSnapshots(db, 5)).toBe(0)
    expect(await db.snapshots.count()).toBe(1)
  })

  it('drops the oldest captures beyond the cap', async () => {
    const db = await freshDb()
    for (let index = 0; index < 6; index++) {
      await putSnapshot(db, { ...aSnapshotFor(`p${index}`), capturedAt: index })
    }

    expect(await pruneSnapshots(db, 3)).toBe(3)

    const kept = await db.snapshots.orderBy('capturedAt').primaryKeys()
    expect(kept).toEqual(['p3', 'p4', 'p5'])
  })

  // Records are never dropped, only their snapshots — a swept posting still
  // lists, still dedupes, still exports.
  it('never touches the records themselves', async () => {
    const db = await freshDb()
    for (let index = 0; index < 4; index++) {
      await upsertPosting(db, aPosting({ id: `p${index}` }))
      await putSnapshot(db, { ...aSnapshotFor(`p${index}`), capturedAt: index })
    }

    await pruneSnapshots(db, 1)

    expect(await countPostings(db)).toBe(4)
    expect(await getPosting(db, 'p0')).not.toBeNull()
  })

  it('defaults to the retention figure decision 6 named', () => {
    expect(SNAPSHOT_RETENTION).toBe(500)
  })
})

describe('wipeAll', () => {
  it('empties both stores and says how much it took', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting({ id: 'a' }))
    await upsertPosting(db, aPosting({ id: 'b' }))
    await putSnapshot(db, aSnapshotFor('a'))

    expect(await wipeAll(db)).toEqual({ postings: 2, snapshots: 1 })
    expect(await countPostings(db)).toBe(0)
    expect(await db.snapshots.count()).toBe(0)
  })

  it('is safe on an empty database', async () => {
    const db = await freshDb()
    expect(await wipeAll(db)).toEqual({ postings: 0, snapshots: 0 })
  })
})

describe('listSnapshotIds', () => {
  it('names only the postings that actually have a page', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting({ id: 'a' }))
    await upsertPosting(db, aPosting({ id: 'b' }))
    await putSnapshot(db, aSnapshotFor('b'))

    expect(await listSnapshotIds(db)).toEqual(['b'])
    expect(await listSnapshots(db, ['a', 'b'])).toHaveLength(1)
  })
})

/** A record as it comes out of an export file: already stored-shaped. */
function aStored(overrides: Partial<Posting> = {}): Posting {
  return {
    ...(aPosting() as Posting),
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function aSnapshotFor(postingId: string): Snapshot {
  return {
    postingId,
    capturedAt: 1,
    adapterVersion: 'jsonld@1',
    trimmedSource: `<html>${postingId}</html>`,
    truncated: false,
  }
}

/**
 * The never-overwrite rule has to hold against the *file* as well as against
 * the store. The batch's existence check is one `bulkGet` taken before any
 * write, so without an intra-batch guard two records sharing an id both look
 * absent, both count as imported, and the later one wins — a record lost, and
 * the summary reporting it as restored.
 */
describe('duplicate ids inside one batch', () => {
  it('keeps the first record and skips the repeat', async () => {
    const db = await freshDb()

    const outcome = await insertMissingPostings(db, [
      aStored({ id: 'a', notes: 'the first one' }),
      aStored({ id: 'a', notes: 'the second one' }),
    ])

    expect(outcome.imported).toEqual(['a'])
    expect(outcome.skipped).toEqual(['a'])
    expect(await countPostings(db)).toBe(1)
    expect((await getPosting(db, 'a'))?.notes).toBe('the first one')
  })

  it('does the same for snapshots', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting({ id: 'a' }))

    const outcome = await insertMissingSnapshots(db, [
      { ...aSnapshotFor('a'), trimmedSource: 'first' },
      { ...aSnapshotFor('a'), trimmedSource: 'second' },
    ])

    expect(outcome.imported).toEqual(['a'])
    expect(outcome.skipped).toEqual(['a'])
    expect((await getSnapshot(db, 'a'))?.trimmedSource).toBe('first')
  })
})

describe('countSnapshotsAmong', () => {
  it('counts only the ids that still have a page', async () => {
    const db = await freshDb()
    await putSnapshot(db, aSnapshotFor('a'))

    expect(await countSnapshotsAmong(db, ['a', 'b'])).toBe(1)
    expect(await countSnapshotsAmong(db, [])).toBe(0)
  })
})
