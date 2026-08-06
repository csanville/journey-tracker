import { describe, expect, it, vi } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import type { DetectionReport } from './detection'
import { handleRequest } from './handler'
import { allowedFromContentScript, type Request } from './messages'
import { SNAPSHOT_RETENTION } from './repository'
import { patchSettings, readSettings } from './settings'
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

  it('badges the tab even when the saved record no longer looks like the page', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 12 })
    vi.mocked(chrome.action.setBadgeText).mockClear()

    // The user cleared the optional URL field and tidied the company name — two
    // ordinary edits, and between them enough to make a query built from the
    // *page* match nothing. The badge is not a question here: the write that
    // just succeeded is what makes this tab tracked, so it is stated.
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting: aPosting({ company: 'Acme', jobTitle: 'Staff Engineer', url: '' }),
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
    expect(allowedFromContentScript('application/submitted')).toBe(true)
    expect(allowedFromContentScript('posting/delete')).toBe(false)
    expect(allowedFromContentScript('posting/upsert')).toBe(false)
    expect(allowedFromContentScript('detection/get')).toBe(false)
  })
})

/**
 * The confirmation-page signal.
 *
 * Nothing here writes: decision 12 says detection prompts rather than writes,
 * and `matched` is the worker reporting what it found, not what the panel will
 * do about it. So every case asserts the record is unchanged as well.
 */
describe('a submitted application', () => {
  const CONFIRMATION =
    'https://boards.greenhouse.io/initech/jobs/4021/confirmation?gh_src=abc'

  const submit = (db: Parameters<typeof handleRequest>[0], url = CONFIRMATION) =>
    handleRequest(db, { kind: 'application/submitted', url }, { tabId: 7 })

  it('matches a confirmation page back to the record it confirms', async () => {
    const db = await freshDb()
    // `aPosting`'s URL carries a tracking parameter its canonical form lacks,
    // so this only matches if the join goes through canonicalization.
    await handleRequest(db, { kind: 'posting/upsert', posting: aPosting({ id: 'p1' }) })

    const response = await submit(db)

    expect(response.ok && response.data).toEqual({ matched: true })

    // Announced, not written. The user has not answered yet.
    const read = await handleRequest(db, { kind: 'posting/get', id: 'p1' })
    expect(read.ok && read.data?.state).toBe('viewed')
  })

  it('says nothing about a page with no record behind it', async () => {
    const db = await freshDb()

    // Manufacturing a posting from a confirmation page — which carries no
    // employer, title or description worth trusting — would put a junk record
    // in the tracker to save one click.
    const response = await submit(db)

    expect(response.ok && response.data).toEqual({ matched: false })
  })

  it('does not ask again about a record already marked applied', async () => {
    const db = await freshDb()
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting: aPosting({ id: 'p1', state: 'applied', appliedAt: 1_000 }),
    })

    const response = await submit(db)

    expect(response.ok && response.data).toEqual({ matched: false })
  })

  it('re-derives the target itself rather than trusting the sender', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'posting/upsert', posting: aPosting({ id: 'p1' }) })

    // The posting URL rather than a confirmation URL. The content script only
    // sends the latter, so this is a message that could only be malformed or
    // forged — and the worker declines it on its own reading, not on trust.
    const response = await submit(db, 'https://boards.greenhouse.io/initech/jobs/4021')

    expect(response.ok && response.data).toEqual({ matched: false })
  })

  it('ignores a submission that arrived without a tab', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'posting/upsert', posting: aPosting({ id: 'p1' }) })

    const response = await handleRequest(db, {
      kind: 'application/submitted',
      url: CONFIRMATION,
    })

    expect(response.ok && response.data).toEqual({ matched: false })
  })

  /**
   * `findDuplicate` also answers on company and title, which is right for "you
   * may have seen this before" and far too loose for "you applied to this" —
   * so only an identity match on the URL counts.
   */
  it('will not match a different posting at the same employer', async () => {
    const db = await freshDb()
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting: aPosting({
        id: 'other',
        url: 'https://boards.greenhouse.io/initech/jobs/9999',
      }),
    })

    const response = await submit(db)

    expect(response.ok && response.data).toEqual({ matched: false })
  })
})

describe('importing a backup', () => {
  const bundlePosting = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...aPosting({ id }),
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1_000,
    updatedAt: 1_000,
    companyNormalized: 'initech',
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    ...overrides,
  })

  /** A record matching the page `aReport()` describes, so the tab is tracked. */
  const trackedPosting = () => ({
    ...aPosting({
      id: 'tracked-1',
      company: 'Acme',
      jobTitle: 'Staff Engineer',
      atsReqId: null,
      url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
    }),
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
    companyNormalized: 'acme',
    canonicalUrl: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
  })

  const aPage = (postingId: string, capturedAt: number) => ({
    postingId,
    capturedAt,
    adapterVersion: 'jsonld@1',
    trimmedSource: `<html>${postingId}</html>`,
    truncated: false,
  })

  it('reports records written and records left alone', async () => {
    const db = await freshDb()

    const first = await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('a'), bundlePosting('b')],
      schemaVersion: SCHEMA_VERSION,
      final: true,
    })
    const again = await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('a')],
      schemaVersion: SCHEMA_VERSION,
      final: true,
    })

    expect(first.ok && first.data).toEqual({ imported: 2, skipped: 0, dropped: 0 })
    expect(again.ok && again.data).toEqual({ imported: 0, skipped: 1, dropped: 0 })
  })

  /**
   * Pages the retention cap reclaims moments after they are written must not be
   * counted as imported. Restoring an old `full` backup into a database of
   * newer captures is exactly this: every page is inserted and immediately
   * swept, and reporting them as added claims pages the database does not have.
   */
  it('counts only the pages that survived the retention sweep', async () => {
    const db = await freshDb()
    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('old')],
      schemaVersion: SCHEMA_VERSION,
      final: true,
    })

    // The database is already at the cap with newer captures, which is what a
    // year-old `full` backup lands in. Written directly: the point is the
    // retention boundary, not how they got there.
    await db.snapshots.bulkPut(
      Array.from({ length: SNAPSHOT_RETENTION }, (_, index) =>
        aPage(`recent-${index}`, 5_000 + index),
      ),
    )

    const response = await handleRequest(db, {
      kind: 'backup/import-snapshots',
      snapshots: [aPage('old', 1_000)],
    })

    // Inserted, then swept for being older than everything already held. The
    // count has to say so — claiming it as imported would promise a page the
    // database does not have.
    expect(response.ok && response.data).toEqual({ imported: 0, skipped: 0, dropped: 1 })
    expect(await db.snapshots.get('old')).toBeUndefined()
  })

  /**
   * The migration of records that arrived behind the current version rewrites
   * the whole table, so running it per batch would do it once per two hundred
   * records imported. The panel says which batch is last.
   */
  it('defers the migration of old records to the final batch', async () => {
    const db = await freshDb()

    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('old', { schemaVersion: 1, companyNormalized: 'wrong' })],
      schemaVersion: 1,
      final: false,
    })

    // The debt is recorded but not yet paid.
    expect((await readSettings()).importedBelowVersion).toBe(1)
    expect((await db.postings.get('old'))?.schemaVersion).toBe(1)

    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [],
      schemaVersion: 1,
      final: true,
    })

    expect((await readSettings()).importedBelowVersion).toBeNull()
    expect((await db.postings.get('old'))?.schemaVersion).toBe(SCHEMA_VERSION)
  })

  // Keying this on the envelope's version instead made re-importing an old
  // backup rewrite the entire table once per batch of records it did not write.
  it('records no debt when a batch imported nothing', async () => {
    const db = await freshDb()
    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('a')],
      schemaVersion: SCHEMA_VERSION,
      final: true,
    })

    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('a', { schemaVersion: 1 })],
      schemaVersion: 1,
      final: false,
    })

    expect((await readSettings()).importedBelowVersion).toBeNull()
  })

  /**
   * The badge is a claim about the record set as much as about the page
   * (decision 16), and a wipe moves the record set under every open tab at
   * once. Left alone, tabs went on asserting records that had just been
   * deleted — while the panel's revisit banner, which re-queries, said
   * otherwise.
   */
  it('clears the badges of tabs still showing a tracked page', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 7 })
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting: trackedPosting(),
      detectionId: 'det-1',
    })

    vi.mocked(chrome.action.setBadgeText).mockClear()
    await handleRequest(db, { kind: 'backup/wipe' })

    expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, text: '' }),
    )
  })

  /**
   * The one thing phase 9 shipped wrong, found by using it rather than by any
   * test: delete a record while its own page is open and the badge went on
   * saying `✓` until the page was reloaded.
   *
   * The panel cannot fix this from its side and the first attempt assumed it
   * could. Its re-read of the active tab goes through `detection/get`, which is
   * a pure cache read — nothing on that path touches the toolbar. Only a fresh
   * `detection/report` repaints, and that means a page load. So the repaint
   * belongs here, in the only context that both knows the record is gone and
   * can reach `chrome.action`.
   *
   * The same shape as the wipe below, one record at a time, and the same shape
   * as the comment that claimed the panel handled it: a statement about a
   * mechanism, checked by its existence rather than by its behaviour.
   */
  it('clears the badge of a tab showing the record just deleted', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 7 })
    const posting = trackedPosting()
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting,
      detectionId: 'det-1',
    })

    vi.mocked(chrome.action.setBadgeText).mockClear()
    await handleRequest(db, { kind: 'posting/delete', id: posting.id })

    expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, text: '' }),
    )
  })

  it('leaves the badge of a tab whose record survives the deletion', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 7 })
    await handleRequest(db, {
      kind: 'posting/upsert',
      posting: trackedPosting(),
      detectionId: 'det-1',
    })

    vi.mocked(chrome.action.setBadgeText).mockClear()
    // Some other record entirely. Re-asking must not turn into clearing.
    await handleRequest(db, { kind: 'posting/delete', id: 'not-the-one-on-screen' })

    expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, text: '✓' }),
    )
  })

  it('lights the badge of a tab whose record a restore brought back', async () => {
    const db = await freshDb()
    await handleRequest(db, { kind: 'detection/report', report: aReport() }, { tabId: 7 })

    vi.mocked(chrome.action.setBadgeText).mockClear()
    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [trackedPosting()],
      schemaVersion: SCHEMA_VERSION,
      final: true,
    })

    expect(vi.mocked(chrome.action.setBadgeText)).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, text: expect.not.stringMatching(/^$/) }),
    )
  })

  it('empties both stores on a wipe and says how much it took', async () => {
    const db = await freshDb()
    await handleRequest(db, {
      kind: 'backup/import-postings',
      postings: [bundlePosting('a')],
      schemaVersion: SCHEMA_VERSION,
      final: true,
    })
    await handleRequest(db, { kind: 'snapshot/put', snapshot: aPage('a', 1) })

    const response = await handleRequest(db, { kind: 'backup/wipe' })

    expect(response.ok && response.data).toEqual({ postings: 1, snapshots: 1 })
    expect(await db.postings.count()).toBe(0)
  })
})
