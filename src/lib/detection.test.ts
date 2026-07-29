import { describe, expect, it } from 'vitest'
import {
  MAX_CACHED_TABS,
  findSnapshot,
  forgetTab,
  getDetectionSummary,
  recordDetection,
  sanitizeReport,
  type DetectionReport,
} from './detection'

function aReport(overrides: Partial<DetectionReport> = {}): DetectionReport {
  return {
    detectionId: 'det-1',
    url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
    source: 'lever',
    adapterVersion: 'lever@1',
    confidence: 0.7,
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
    snapshot: { trimmedSource: '<html>…</html>', truncated: false },
    ...overrides,
  }
}

describe('sanitizeReport', () => {
  it('accepts a well-formed report unchanged', () => {
    expect(sanitizeReport(aReport())).toEqual(aReport())
  })

  it('rejects a report with neither a company nor a title', () => {
    // It would put a fill button in the panel that fills nothing.
    const empty = aReport()
    empty.fields = { ...empty.fields, company: null, jobTitle: null }

    expect(sanitizeReport(empty)).toBeNull()
  })

  it('accepts a report with only one of the two', () => {
    const partial = aReport()
    partial.fields = { ...partial.fields, company: null }

    expect(sanitizeReport(partial)?.fields.jobTitle).toBe('Staff Engineer')
  })

  it('rejects what is not a report at all', () => {
    expect(sanitizeReport(null)).toBeNull()
    expect(sanitizeReport('detection')).toBeNull()
    expect(sanitizeReport({})).toBeNull()
    expect(sanitizeReport(aReport({ confidence: 1.5 }))).toBeNull()
    expect(sanitizeReport(aReport({ detectionId: '' }))).toBeNull()
  })

  it('drops an over-long field rather than storing it', () => {
    // A page is free to put a megabyte in its `<title>`. The extractor caps
    // field length already; this is the difference between a cap and a wish.
    const huge = aReport()
    huge.fields = { ...huge.fields, company: 'x'.repeat(5000) }

    expect(sanitizeReport(huge)?.fields.company).toBeNull()
  })

  it('drops a work mode and a salary period that are not in the type', () => {
    const bogus = aReport()
    bogus.fields = {
      ...bogus.fields,
      workMode: 'probably' as never,
      salary: { min: 1, max: 2, currency: 'USD', period: 'fortnight' as never, raw: 'x' },
    }

    const clean = sanitizeReport(bogus)

    expect(clean?.fields.workMode).toBeNull()
    expect(clean?.fields.salary?.period).toBeNull()
    expect(clean?.fields.salary?.min).toBe(1)
  })

  it('drops a tier name that is not one of ours', () => {
    const bogus = aReport()
    bogus.provenance = { ...bogus.provenance, company: 'psychic' as never }

    expect(sanitizeReport(bogus)?.provenance.company).toBeNull()
  })

  it('discards an over-cap snapshot but keeps the detection', () => {
    const huge = aReport({
      snapshot: { trimmedSource: 'x'.repeat(300 * 1024), truncated: false },
    })

    const clean = sanitizeReport(huge)

    expect(clean?.fields.company).toBe('Acme')
    expect(clean?.snapshot.trimmedSource).toBe('')
    expect(clean?.snapshot.truncated).toBe(true)
  })
})

describe('the detection cache', () => {
  it('stores a detection against its tab and hands back a summary', async () => {
    await recordDetection(7, aReport(), 1000)

    const summary = await getDetectionSummary(7)

    expect(summary).toMatchObject({
      detectionId: 'det-1',
      source: 'lever',
      capturedAt: 1000,
      snapshotBytes: '<html>…</html>'.length,
    })
    // The panel has no use for 256KB of page text, and sending it would put it
    // through two message hops into a React state tree.
    expect(summary).not.toHaveProperty('snapshot')
  })

  it('answers for a tab nothing was detected on', async () => {
    expect(await getDetectionSummary(99)).toBeNull()
  })

  it('replaces a tab’s detection when the page changes', async () => {
    await recordDetection(7, aReport({ detectionId: 'first' }), 1000)
    await recordDetection(7, aReport({ detectionId: 'second' }), 2000)

    expect((await getDetectionSummary(7))?.detectionId).toBe('second')
  })

  it('evicts the oldest once the cache is full', async () => {
    // A user with forty job tabs open is not unusual, and an unbounded cache
    // would fill the session budget and start failing writes in the worker,
    // where nobody would see it.
    for (let tab = 0; tab <= MAX_CACHED_TABS; tab++) {
      await recordDetection(tab, aReport({ detectionId: `det-${tab}` }), 1000 + tab)
    }

    expect(await getDetectionSummary(0)).toBeNull()
    expect(await getDetectionSummary(MAX_CACHED_TABS)).not.toBeNull()
  })

  it('finds a snapshot by detection id, wherever the tab has got to', async () => {
    await recordDetection(7, aReport({ detectionId: 'wanted' }), 1000)
    await recordDetection(8, aReport({ detectionId: 'other' }), 2000)

    expect((await findSnapshot('wanted'))?.snapshot.trimmedSource).toBe('<html>…</html>')
  })

  it('finds nothing once the tab that reported it has moved on', async () => {
    // Correct rather than a miss: the only snapshot available is of a different
    // page, and attaching that to the record would be a lie recorded forever.
    await recordDetection(7, aReport({ detectionId: 'old' }), 1000)
    await recordDetection(7, aReport({ detectionId: 'new' }), 2000)

    expect(await findSnapshot('old')).toBeNull()
  })

  it('forgets a tab that closed', async () => {
    await recordDetection(7, aReport(), 1000)
    await forgetTab(7)

    expect(await getDetectionSummary(7)).toBeNull()
    // And forgetting a tab that was never there is not an error.
    await expect(forgetTab(99)).resolves.toBeUndefined()
  })
})
