import { describe, expect, it } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import { handleRequest } from './handler'
import type { Request } from './messages'
import { patchSettings } from './settings'
import { SCHEMA_VERSION } from './types'

describe('handleRequest', () => {
  it('writes and reads a posting across the message boundary', async () => {
    const db = await freshDb()
    const posting = aPosting()

    const written = await handleRequest(db, { kind: 'posting/upsert', posting })
    expect(written.ok).toBe(true)

    const read = await handleRequest(db, { kind: 'posting/get', id: posting.id })
    expect(read.ok && read.data?.jobTitle).toBe('Staff Engineer')
  })

  it('reports an error instead of throwing across the boundary', async () => {
    const db = await freshDb()

    // A malformed request is what a version-skewed panel would send; the worker
    // has to answer rather than die, or the panel hangs waiting.
    const response = await handleRequest(db, {
      kind: 'posting/upsert',
      posting: undefined,
    } as unknown as Request<'posting/upsert'>)

    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toBeTruthy()
  })

  it('rejects an unknown request kind', async () => {
    const db = await freshDb()
    const response = await handleRequest(db, { kind: 'nonsense' } as unknown as Request)
    expect(response.ok).toBe(false)
  })

  it('reports status including whether storage is evictable', async () => {
    const db = await freshDb()
    await patchSettings({
      dataVersion: SCHEMA_VERSION,
      storagePersisted: false,
      storageUnlimited: false,
    })
    await handleRequest(db, { kind: 'posting/upsert', posting: aPosting() })

    const response = await handleRequest(db, { kind: 'status' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.postingCount).toBe(1)
    expect(response.data.schemaVersion).toBe(SCHEMA_VERSION)
    // The value the UI acts on. Both defences down means a real warning.
    expect(response.data.evictionSafe).toBe(false)
  })

  it('reports eviction-safe when unlimitedStorage alone is granted', async () => {
    const db = await freshDb()
    await patchSettings({ storagePersisted: false, storageUnlimited: true })

    const response = await handleRequest(db, { kind: 'status' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    // Warning on storagePersisted alone here would cry wolf on every fresh
    // install, which is how a real warning gets ignored later.
    expect(response.data.evictionSafe).toBe(true)
  })

  it('deletes through the same path', async () => {
    const db = await freshDb()
    const posting = aPosting()
    await handleRequest(db, { kind: 'posting/upsert', posting })

    await handleRequest(db, { kind: 'posting/delete', id: posting.id })

    const count = await handleRequest(db, { kind: 'posting/count' })
    expect(count.ok && count.data).toBe(0)
  })
})
