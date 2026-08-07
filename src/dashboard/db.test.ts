import { beforeEach, describe, expect, it, vi } from 'vitest'
import Dexie from 'dexie'
import { openForReading, readPostings, subscribeToPostings } from './db'
import { JourneyTrackerDb } from '../lib/db'
import { aPosting } from '../test/factories'
import { upsertPosting } from '../lib/repository'
import type { Posting } from '../lib/types'

/**
 * These are not tests of Dexie. They pin the one assumption the whole dashboard
 * read path rests on: that a connection declaring no schema reads the database
 * without ever upgrading it. If that stops holding, the dashboard becomes a
 * second context capable of restructuring the store, which is what decision 14's
 * amendment refused — and it would fail silently, on someone's real data, on the
 * first release that adds an index.
 */

let counter = 0
const dbName = () => `dash-${Date.now()}-${counter++}`

/** The worker's side: the only context that declares a schema. */
async function workerDb(name: string): Promise<JourneyTrackerDb> {
  const db = new JourneyTrackerDb(name)
  await db.open()
  return db
}

/**
 * A reachable worker, as the default.
 *
 * Every open now goes through `status` so the worker can migrate before the
 * dashboard reads, which makes an answering worker a precondition of these
 * tests rather than a detail of one of them — the shared stub in `test/setup.ts`
 * resolves `undefined`, which `send` treats as a torn-down worker.
 *
 * Deliberately does *not* open the database: the two version tests below put a
 * store on disk that the worker's own schema-declaring connection could not open
 * without a downgrade, and the creation test arms its own stub for the one case
 * that needs the side effect.
 */
beforeEach(() => {
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
    ok: true,
    data: { postingCount: 0 },
  } as never)
})

describe('openForReading', () => {
  it('reads a database it did not declare', async () => {
    const name = dbName()
    const worker = await workerDb(name)
    await upsertPosting(worker, aPosting({ company: 'Initech' }))
    worker.close()

    const reader = await openForReading(name)

    expect(reader.tables.map((t) => t.name).sort()).toEqual(['postings', 'snapshots'])
    expect(await readPostings(reader)).toHaveLength(1)
    reader.close()
  })

  it('opens at whatever version the worker has reached, without upgrading it', async () => {
    // The scenario decision 14's amendment was worried about: a release adds an
    // index, and the question is which context performs the upgrade. A reader
    // with no version of its own has nothing to upgrade to.
    const name = dbName()
    ;(await workerDb(name)).close()

    const upgraded = new Dexie(name)
    upgraded.version(1).stores({ postings: 'id, canonicalUrl', snapshots: 'postingId' })
    upgraded.version(2).stores({
      postings: 'id, canonicalUrl, appliedAt',
      snapshots: 'postingId',
    })
    await upgraded.open()
    upgraded.close()

    const reader = await openForReading(name)

    expect(reader.verno).toBe(2)
    reader.close()
  })

  /**
   * Schema version 3 added `stage` and `outcome` to every record and
   * deliberately indexed neither, so it needed no `version().stores()` bump —
   * a data migration, not a structural upgrade (the distinction `lib/db.ts`
   * draws in its own header).
   *
   * This is here rather than beside `lib/db.ts` because the dashboard is what
   * pays if it stops being true. A structural upgrade added without thinking
   * about this file is exactly the release the tests above describe: whichever
   * context declares the higher version performs the upgrade, and the reader is
   * built never to be that context.
   */
  it('needed no structural upgrade for the version 3 fields', async () => {
    const name = dbName()
    const worker = await workerDb(name)

    expect(worker.verno).toBe(1)
    worker.close()
  })

  it('never downgrades a database newer than the build it is running in', async () => {
    const name = dbName()
    const ahead = new Dexie(name)
    ahead.version(7).stores({ postings: 'id', snapshots: 'postingId' })
    await ahead.open()
    ahead.close()

    const reader = await openForReading(name)

    expect(reader.verno).toBe(7)
    reader.close()
  })

  it('asks the worker to create a database that does not exist yet', async () => {
    // Dynamic mode cannot create the store — that is the point of using it — so
    // the first-ever dashboard open has to go through the single writer.
    const name = dbName()
    const created = vi.fn(async () => {
      const db = await workerDb(name)
      db.close()
      return { ok: true, data: { postingCount: 0 } }
    })
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(created as never)

    const reader = await openForReading(name)

    expect(created).toHaveBeenCalledOnce()
    expect(reader.tables.map((t) => t.name)).toContain('postings')
    reader.close()
  })

  /**
   * The regression test for phase 8's worst defect, and the reason this file
   * gained a `beforeEach`.
   *
   * The round-trip used to be conditional — reached only after Dexie reported
   * the database missing — so it ran on the first-ever open and never again.
   * Every subsequent open read whatever was on disk, unmigrated, which is how
   * records written at version 2 reached an aggregation written against
   * version 3 and made it render "0 still open" over open applications.
   *
   * Asserting on the message rather than on the data because the shape of the
   * failure is contextual: it needs a database left behind by an older build,
   * which is exactly what cannot be arranged after the fact. What can be pinned
   * is that the worker is asked every time, which is what makes the shape
   * unreachable.
   */
  it('goes through the worker on every open, not only when the database is missing', async () => {
    const name = dbName()
    const worker = await workerDb(name)
    await upsertPosting(worker, aPosting({ company: 'Initech' }))
    worker.close()

    const reader = await openForReading(name)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'status' }),
    )
    reader.close()
  })

  it('surfaces an unreachable worker as itself, not as an empty dashboard', async () => {
    // "No data" and "cannot reach the worker" are different statements about
    // someone's records, and only one of them is reassuring.
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined as never)

    await expect(openForReading(dbName())).rejects.toThrow(
      /no response from the service worker/,
    )
  })

  /**
   * The cost of gating the open, stated as a test so it is a decision rather
   * than a surprise.
   *
   * Before the fix this case succeeded: the database exists, so the old code
   * never sent anything and never noticed the worker was gone. It now fails,
   * and that is the intended trade — the rows are readable but their shape is
   * unknown, and `usePostings` renders a failure honestly while it would render
   * unmigrated data as fact.
   */
  it('fails rather than serving data of unknown shape when the worker is gone', async () => {
    const name = dbName()
    const worker = await workerDb(name)
    await upsertPosting(worker, aPosting({ company: 'Initech' }))
    worker.close()

    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined as never)

    await expect(openForReading(name)).rejects.toThrow(
      /no response from the service worker/,
    )
  })
})

describe('readPostings', () => {
  it('returns newest first', async () => {
    const name = dbName()
    const worker = await workerDb(name)
    await upsertPosting(worker, aPosting({ id: 'old', company: 'Older' }))
    await upsertPosting(worker, aPosting({ id: 'new', company: 'Newer' }))
    // `updatedAt` is stamped by the repository; force a gap rather than racing
    // two writes inside the same millisecond.
    await worker.postings.update('old', { updatedAt: 1_000 })
    await worker.postings.update('new', { updatedAt: 2_000 })
    worker.close()

    const reader = await openForReading(name)
    const postings = await readPostings(reader)

    expect(postings.map((p) => p.id)).toEqual(['new', 'old'])
    reader.close()
  })

  it('reads an empty store as empty rather than failing', async () => {
    const name = dbName()
    ;(await workerDb(name)).close()

    const reader = await openForReading(name)

    expect(await readPostings(reader)).toEqual([])
    reader.close()
  })
})

describe('subscribeToPostings', () => {
  it('sees a write made through the worker’s own connection', async () => {
    // The reactivity decision 4 promised, across two connections rather than
    // one. Without this the dashboard would need the polling that decision
    // explicitly ruled out.
    const name = dbName()
    const worker = await workerDb(name)
    const reader = await openForReading(name)

    const seen: Posting[][] = []
    const stop = subscribeToPostings(
      reader,
      (postings) => seen.push(postings),
      (error) => {
        throw error
      },
    )

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual([])

    await upsertPosting(worker, aPosting({ company: 'Initech' }))

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1))
    expect(seen.at(-1)).toHaveLength(1)

    stop()
    worker.close()
    reader.close()
  })

  it('stops delivering after unsubscribe', async () => {
    const name = dbName()
    const worker = await workerDb(name)
    const reader = await openForReading(name)

    const seen: Posting[][] = []
    const stop = subscribeToPostings(
      reader,
      (postings) => seen.push(postings),
      () => {},
    )
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    stop()

    await upsertPosting(worker, aPosting({ company: 'Initech' }))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(seen).toHaveLength(1)
    worker.close()
    reader.close()
  })
})
