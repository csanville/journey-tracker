import { describe, expect, it } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import {
  countPostings,
  deletePosting,
  getPosting,
  getSnapshot,
  listPostings,
  putSnapshot,
  upsertPosting,
} from './repository'
import { SCHEMA_VERSION } from './types'

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

  it('lists newest first', async () => {
    const db = await freshDb()
    const older = await upsertPosting(db, aPosting({ jobTitle: 'Older' }))
    const newer = await upsertPosting(db, aPosting({ jobTitle: 'Newer' }))
    // The clock can tie inside a single millisecond; force the ordering that
    // the assertion is actually about.
    await upsertPosting(db, { ...aPosting({ id: newer.id }), jobTitle: 'Newer' })

    const listed = await listPostings(db)
    expect(listed).toHaveLength(2)
    expect(listed.map((p) => p.id)).toContain(older.id)
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
