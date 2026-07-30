import { describe, expect, it, vi } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import type { DetectionReport } from './detection'
import { handleRequest } from './handler'
import { allowedFromContentScript, type Request } from './messages'
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

/** A report as a content script would send it, with a snapshot attached. */
function aReport(overrides: Partial<DetectionReport> = {}): DetectionReport {
  return {
    detectionId: 'det-1',
    url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
    source: 'lever',
    adapterVersion: 'lever@1',
    confidence: 0.71,
    fields: {
      company: 'Acme',
      jobTitle: 'Staff Engineer',
      location: 'Berlin',
      workMode: 'hybrid',
      atsReqId: null,
      salary: null,
    },
    provenance: {
      company: 'jsonld',
      jobTitle: 'jsonld',
      location: 'jsonld',
      workMode: 'dom',
      atsReqId: null,
      salary: null,
    },
    snapshot: { trimmedSource: '<html>the posting</html>', truncated: false },
    ...overrides,
  }
}

describe('detection', () => {
  it('carries a page from the content script to the panel', async () => {
    const db = await freshDb()

    const stored = await handleRequest(
      db,
      { kind: 'detection/report', report: aReport() },
      { tabId: 12 },
    )
    expect(stored.ok && stored.data).toEqual({ detectionId: 'det-1' })

    // The panel asks by tab id, which it gets from `chrome.tabs.query` without
    // needing the `tabs` permission.
    const read = await handleRequest(db, { kind: 'detection/get', tabId: 12 })

    expect(read.ok && read.data).toMatchObject({
      detectionId: 'det-1',
      source: 'lever',
      snapshotBytes: '<html>the posting</html>'.length,
    })
  })

  it('ignores a report that arrived without a tab', async () => {
    const db = await freshDb()

    // Which is to say, one that did not come from a content script. A detection
    // not attached to a tab is one the panel could never ask for.
    const response = await handleRequest(db, {
      kind: 'detection/report',
      report: aReport(),
    })

    expect(response.ok && response.data).toBeNull()
  })

  it('ignores a report that does not survive validation', async () => {
    const db = await freshDb()
    const junk = aReport()
    junk.fields = { ...junk.fields, company: null, jobTitle: null }

    const response = await handleRequest(
      db,
      { kind: 'detection/report', report: junk },
      { tabId: 12 },
    )

    expect(response.ok && response.data).toBeNull()

    const read = await handleRequest(db, { kind: 'detection/get', tabId: 12 })
    expect(read.ok && read.data).toBeNull()
  })

  it('stores the snapshot of the page a record was filled from', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })

    const posting = aPosting()
    await handleRequest(db, { kind: 'posting/upsert', posting, detectionId: 'det-1' })

    const snapshot = await handleRequest(db, {
      kind: 'snapshot/get',
      postingId: posting.id,
    })

    expect(snapshot.ok && snapshot.data).toMatchObject({
      postingId: posting.id,
      adapterVersion: 'lever@1',
      trimmedSource: '<html>the posting</html>',
      truncated: false,
    })
  })

  it('saves the record even when the detection has expired', async () => {
    const db = await freshDb()
    const posting = aPosting()

    // The tab navigated on, so the only snapshot available is of a different
    // page. Writing none is the right answer, and it must not cost the user the
    // application they just filed.
    const response = await handleRequest(db, {
      kind: 'posting/upsert',
      posting,
      detectionId: 'long-gone',
    })

    expect(response.ok).toBe(true)
    const snapshot = await handleRequest(db, {
      kind: 'snapshot/get',
      postingId: posting.id,
    })
    expect(snapshot.ok && snapshot.data).toBeNull()
  })

  it('leaves a hand-typed record without a snapshot', async () => {
    const db = await freshDb()
    const posting = aPosting()

    await handleRequest(db, { kind: 'posting/upsert', posting })

    const snapshot = await handleRequest(db, {
      kind: 'snapshot/get',
      postingId: posting.id,
    })
    expect(snapshot.ok && snapshot.data).toBeNull()
  })
})

describe('marking a tab that is already tracked', () => {
  /** The stored record `aReport()` describes, already normalized. */
  async function storeMatching(db: Awaited<ReturnType<typeof freshDb>>) {
    await db.postings.add({
      ...aPosting({
        id: 'stored-1',
        company: 'Acme',
        jobTitle: 'Staff Engineer',
        atsReqId: null,
      }),
      companyNormalized: 'acme',
      canonicalUrl: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
      schemaVersion: SCHEMA_VERSION,
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  it('badges the tab when the page is one already saved', async () => {
    const db = await freshDb()
    await storeMatching(db)

    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '✓' })
  })

  it('clears the badge for a page that is not tracked', async () => {
    const db = await freshDb()

    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '' })
  })

  it('tells the panel a tab changed', async () => {
    const db = await freshDb()

    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'detection/changed',
      tabId: 12,
    })
  })

  it('badges the tab a save came from, found via the detection id', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })
    vi.mocked(chrome.action.setBadgeText).mockClear()

    // The panel has no tab of its own, so the tab is derived from the
    // `detectionId` the save already carries for the snapshot. The record
    // carries the page's own URL, because that is what filling from it does.
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting: aPosting({
        company: 'Acme',
        jobTitle: 'Staff Engineer',
        atsReqId: null,
        url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
      }),
      detectionId: 'det-1',
    })

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: '✓' })
  })

  it('does not fail the save when the toolbar rejects the badge', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })
    vi.mocked(chrome.action.setBadgeText).mockRejectedValueOnce(new Error('no such tab'))

    // The tab closed between the report and the save. The record is written and
    // that is what the user asked for; a badge is decoration.
    const response = await handleRequest(db, {
      kind: 'posting/upsert',
      posting: aPosting(),
      detectionId: 'det-1',
    })

    expect(response.ok).toBe(true)
  })

  it('leaves a hand-typed save alone — there is no page to mark', async () => {
    const db = await freshDb()

    await handleRequest(db, { kind: 'posting/upsert', posting: aPosting() })

    expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
  })
})

describe('allowedFromContentScript', () => {
  it('lets a content script report, and nothing else', () => {
    // Not a wall against an attacker — a web page cannot reach `onMessage` at
    // all. A wall against an ambient capability nothing uses.
    expect(allowedFromContentScript('detection/report')).toBe(true)
    expect(allowedFromContentScript('posting/delete')).toBe(false)
    expect(allowedFromContentScript('posting/upsert')).toBe(false)
    expect(allowedFromContentScript('detection/get')).toBe(false)
  })
})
