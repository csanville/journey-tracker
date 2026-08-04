/**
 * Phase 6's acceptance test: export, wipe, re-import, data identical.
 *
 * Run through the real message layer rather than against the repository
 * directly. `chrome.runtime.sendMessage` is pointed at `handleRequest` over a
 * real (fake-indexeddb) database, so the batching, the envelope, the validator
 * and the skip-on-conflict rule are all exercised as the panel exercises them.
 * A round trip that only ever ran repository-to-repository would prove nothing
 * about the half of this that is a file and a message port.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '../lib/client'
import type { JourneyTrackerDb } from '../lib/db'
import { handleRequest } from '../lib/handler'
import type { Request } from '../lib/messages'
import * as repo from '../lib/repository'
import type { Posting, Snapshot } from '../lib/types'
import { aPosting, freshDb } from '../test/factories'
import {
  backupFilename,
  buildExport,
  chunk,
  csvFilename,
  importBundle,
  serializeBundle,
} from './backup'

/** Points the panel's `send` at a worker holding this database. */
function connect(db: JourneyTrackerDb): void {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (message: unknown) =>
    handleRequest(db, message as Request)) as never)
}

async function seed(db: JourneyTrackerDb, count: number): Promise<Posting[]> {
  const written: Posting[] = []

  for (let index = 0; index < count; index++) {
    written.push(
      await repo.upsertPosting(
        db,
        aPosting({
          id: `seed-${index}`,
          company: `Employer ${index}`,
          jobTitle: `Engineer ${index}`,
          url: `https://boards.greenhouse.io/employer${index}/jobs/${index}`,
          notes: index % 2 === 0 ? 'Called back, second round on Tuesday' : null,
        }),
      ),
    )
  }

  return written
}

function aSnapshot(postingId: string): Snapshot {
  return {
    postingId,
    capturedAt: 1_700_000_000_000,
    adapterVersion: 'greenhouse@1',
    trimmedSource: `<html><title>${postingId}</title><body>a posting</body></html>`,
    truncated: false,
  }
}

/** Newest-first ordering is `listPostings`'s, and it must survive a restore. */
async function contents(db: JourneyTrackerDb) {
  return {
    postings: await repo.listPostings(db),
    snapshots: await repo.listSnapshots(db, await repo.listSnapshotIds(db)),
  }
}

let db: JourneyTrackerDb

beforeEach(async () => {
  db = await freshDb()
  connect(db)
})

describe('export, wipe, re-import', () => {
  it('restores records and pages to exactly what was exported', async () => {
    const seeded = await seed(db, 5)
    for (const posting of seeded.slice(0, 3)) {
      await repo.putSnapshot(db, aSnapshot(posting.id))
    }

    const before = await contents(db)
    const file = serializeBundle(await buildExport('full'))

    await send('backup/wipe', {})
    expect((await contents(db)).postings).toEqual([])

    const result = await importBundle(file)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.summary.postings).toEqual({ imported: 5, skipped: 0, dropped: 0 })
    expect(result.summary.snapshots).toEqual({ imported: 3, skipped: 0, dropped: 0 })
    expect(result.summary.rejected).toEqual([])
    expect(await contents(db)).toEqual(before)
  })

  /**
   * The timestamps are the part that is easy to lose and impossible to notice.
   * `upsertPosting` stamps `updatedAt` with the current time, which is right
   * for a save and wrong for a restore — a history re-imported through that
   * path arrives with every record edited today, in one indistinguishable
   * block, and "newest first" means nothing ever again.
   */
  it('keeps the original timestamps rather than stamping the restore', async () => {
    const [seeded] = await seed(db, 1)
    const file = serializeBundle(await buildExport('lean'))

    await send('backup/wipe', {})
    await importBundle(file)

    const restored = await repo.getPosting(db, seeded!.id)

    expect(restored?.createdAt).toBe(seeded!.createdAt)
    expect(restored?.updatedAt).toBe(seeded!.updatedAt)
  })

  it('carries no page content in a lean export', async () => {
    const [seeded] = await seed(db, 1)
    await repo.putSnapshot(db, aSnapshot(seeded!.id))

    const bundle = await buildExport('lean')

    expect(bundle.postings).toHaveLength(1)
    expect(bundle.snapshots).toEqual([])
    expect(serializeBundle(bundle)).not.toContain('a posting')
  })
})

describe('importing over data that is already here', () => {
  /**
   * Decision 14's promise, and the case it was written for: a re-imported
   * backup is far more likely than a deliberate correction, so a duplicate id
   * is skipped and the stored record is left exactly as it is.
   */
  it('never overwrites a record that has been edited since', async () => {
    const [seeded] = await seed(db, 1)
    const file = serializeBundle(await buildExport('lean'))

    const edited = await repo.upsertPosting(db, {
      ...aPosting({ id: seeded!.id }),
      notes: 'Rejected — do not reapply',
    })

    const result = await importBundle(file)

    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.summary.postings).toEqual({ imported: 0, skipped: 1, dropped: 0 })

    const stored = await repo.getPosting(db, seeded!.id)
    expect(stored?.notes).toBe('Rejected — do not reapply')
    expect(stored?.updatedAt).toBe(edited.updatedAt)
  })

  it('is a no-op when the same file is imported twice', async () => {
    await seed(db, 3)
    const file = serializeBundle(await buildExport('full'))

    await send('backup/wipe', {})
    await importBundle(file)
    const afterFirst = await contents(db)

    await importBundle(file)

    expect(await contents(db)).toEqual(afterFirst)
  })

  /**
   * A page for a record that was skipped is still a gain — it adds a re-parse
   * that was not possible before and changes no record.
   */
  it('adds a page to a record that is here without one', async () => {
    const [seeded] = await seed(db, 1)
    await repo.putSnapshot(db, aSnapshot(seeded!.id))
    const file = serializeBundle(await buildExport('full'))

    await db.snapshots.clear()
    const result = await importBundle(file)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.summary.postings).toEqual({ imported: 0, skipped: 1, dropped: 0 })
      expect(result.summary.snapshots).toEqual({ imported: 1, skipped: 0, dropped: 0 })
    }
  })

  /**
   * A snapshot whose posting is not here could only be reached by looking up an
   * id that does not exist — up to 256KB of page text that nothing can read,
   * which is the one thing decision 6 does not do.
   */
  it('drops a page whose record was rejected, rather than storing an orphan', async () => {
    const file = JSON.stringify({
      format: 'journeytracker-export',
      formatVersion: 1,
      variant: 'full',
      exportedAt: Date.now(),
      schemaVersion: 2,
      postings: [{ id: 'orphan', jobTitle: 'No company', createdAt: 1 }],
      snapshots: [aSnapshot('orphan')],
    })

    const result = await importBundle(file)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.summary.postings.imported).toBe(0)
    expect(result.summary.snapshots).toEqual({ imported: 0, skipped: 1, dropped: 0 })
    expect(result.summary.rejected).toEqual([{ at: 'orphan', reason: 'no company' }])
    expect(await db.snapshots.count()).toBe(0)
  })
})

describe('a file that is not a backup', () => {
  it('writes nothing at all when the envelope is refused', async () => {
    await seed(db, 2)
    const before = await contents(db)

    const result = await importBundle('{"format":"something-else"}')

    expect(result).toMatchObject({ ok: false })
    expect(await contents(db)).toEqual(before)
  })

  it('explains itself rather than throwing', async () => {
    const result = await importBundle('}{')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not JSON/)
  })
})

describe('batching', () => {
  /**
   * The export walks snapshots four at a time and the import two hundred
   * records at a time, so a database big enough to need several batches is the
   * only way to know the loops close over the right slice.
   */
  it('round-trips a database larger than one batch', async () => {
    await seed(db, 25)
    for (let index = 0; index < 25; index++) {
      await repo.putSnapshot(db, aSnapshot(`seed-${index}`))
    }

    const before = await contents(db)
    const file = serializeBundle(await buildExport('full'))

    await send('backup/wipe', {})
    const result = await importBundle(file)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.summary.snapshots.imported).toBe(25)
    expect(await contents(db)).toEqual(before)
  })

  it('reports progress that ends at the total', async () => {
    await seed(db, 3)
    await repo.putSnapshot(db, aSnapshot('seed-0'))

    const seen: number[] = []
    const bundle = await buildExport('full', (progress) => {
      expect(progress.done).toBeLessThanOrEqual(progress.total)
      seen.push(progress.done)
    })

    expect(bundle.postings).toHaveLength(3)
    expect(seen.at(-1)).toBe(4)
  })

  it('slices evenly and leaves no remainder behind', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
})

describe('filenames', () => {
  it('date the file and name the variant, since one of the two is shareable', () => {
    const at = new Date(2026, 7, 3, 14, 30).getTime()

    expect(backupFilename('lean', at)).toBe('journeytracker-2026-08-03-lean.json')
    expect(backupFilename('full', at)).toBe('journeytracker-2026-08-03-full.json')
    expect(csvFilename(at)).toBe('journeytracker-2026-08-03.csv')
  })
})
