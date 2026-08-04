import { describe, expect, it, vi } from 'vitest'
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

  it('surfaces an unreachable worker as itself, not as an empty dashboard', async () => {
    // "No data" and "cannot reach the worker" are different statements about
    // someone's records, and only one of them is reassuring.
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined as never)

    await expect(openForReading(dbName())).rejects.toThrow(
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
