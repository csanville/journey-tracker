import { describe, expect, it } from 'vitest'
import {
  MAX_CACHED_TABS,
  findSnapshot,
  forgetTab,
  getDetectionSummary,
  getFailedParse,
  recordDetection,
  recordFailedParse,
  sanitizeFailedParse,
  sanitizeReport,
  type DetectionReport,
  type FailedParseReport,
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

  it('keeps both tabs when two content scripts report at once', async () => {
    // Not an exotic interleaving: middle-clicking two postings from a search
    // page makes both content scripts fire their first attempt on the same
    // timer. A read and the write that depends on it are two turns with a gap,
    // and unserialized the second write lands on a cache snapshot taken before
    // the first — so one tab's detection vanishes, and the panel says "no
    // posting detected" for a page that parsed perfectly.
    await Promise.all([
      recordDetection(1, aReport({ detectionId: 'tab-one' }), 1000),
      recordDetection(2, aReport({ detectionId: 'tab-two' }), 1001),
    ])

    expect((await getDetectionSummary(1))?.detectionId).toBe('tab-one')
    expect((await getDetectionSummary(2))?.detectionId).toBe('tab-two')
  })

  it('does not resurrect a closed tab when a forget races a report', async () => {
    await recordDetection(1, aReport({ detectionId: 'doomed' }), 1000)

    await Promise.all([
      forgetTab(1),
      recordDetection(2, aReport({ detectionId: 'live' }), 1002),
    ])

    expect(await getDetectionSummary(1)).toBeNull()
    expect((await getDetectionSummary(2))?.detectionId).toBe('live')
  })

  it('says whether there was a detection to forget', async () => {
    // The answer is what `onUpdated` gates on. That listener fires on every
    // navigation in every tab, so without a cheap "was this one of ours" it
    // wakes the worker, paints a badge and broadcasts to the panel every time
    // the user loads a news article.
    await recordDetection(1, aReport(), 1000)

    expect(await forgetTab(1)).toBe(true)
    expect(await forgetTab(1)).toBe(false)
    expect(await forgetTab(999)).toBe(false)
  })

  it('keeps every tab when a full cache is written concurrently', async () => {
    await Promise.all(
      Array.from({ length: MAX_CACHED_TABS }, (_, tab) =>
        recordDetection(tab, aReport({ detectionId: `det-${tab}` }), 1000 + tab),
      ),
    )

    const found = await Promise.all(
      Array.from({ length: MAX_CACHED_TABS }, (_, tab) => getDetectionSummary(tab)),
    )

    expect(found.filter(Boolean)).toHaveLength(MAX_CACHED_TABS)
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
    // And forgetting a tab that was never there is not an error — it is just a
    // "no".
    await expect(forgetTab(99)).resolves.toBe(false)
  })
})

describe('a read that found nothing', () => {
  function aFailedParse(overrides: Partial<FailedParseReport> = {}): FailedParseReport {
    return {
      url: 'https://careers.acme.com/openings/staff-engineer',
      source: 'generic',
      adapterVersion: 'generic@2',
      confidence: 0,
      provenance: {
        company: null,
        jobTitle: null,
        location: null,
        workMode: null,
        atsReqId: null,
        salary: null,
      },
      ...overrides,
    }
  }

  /**
   * The whole reason this is a separate sanitizer. `sanitizeReport` rejects a
   * report with neither a company nor a title, which is right for a detection
   * and would reject every failed parse there is — the condition it screens out
   * is the condition being reported.
   */
  it('accepts a report with no fields at all, which sanitizeReport rejects', async () => {
    const empty = aFailedParse()

    expect(sanitizeFailedParse(empty)).not.toBeNull()
    expect(sanitizeReport({ ...empty, detectionId: 'det-1', fields: {} })).toBeNull()
  })

  it('drops a tier name the page invented rather than passing it on', () => {
    const failed = sanitizeFailedParse(
      aFailedParse({
        provenance: { company: 'trust-me' } as unknown as FailedParseReport['provenance'],
      }),
    )

    // It reaches a report the user may paste into a public issue, so a page
    // choosing its own strings is not a cosmetic problem.
    expect(failed?.provenance.company).toBeNull()
  })

  it('rejects a report missing the fields a diagnostic is made of', () => {
    expect(sanitizeFailedParse({ ...aFailedParse(), url: '' })).toBeNull()
    expect(sanitizeFailedParse({ ...aFailedParse(), adapterVersion: '' })).toBeNull()
    expect(sanitizeFailedParse({ ...aFailedParse(), confidence: 4 })).toBeNull()
    expect(sanitizeFailedParse(null)).toBeNull()
  })

  it('round-trips against the tab that reported it', async () => {
    await recordFailedParse(7, aFailedParse(), 1000)

    const failed = await getFailedParse(7)
    expect(failed?.source).toBe('generic')
    expect(failed?.capturedAt).toBe(1000)
    expect(await getFailedParse(9)).toBeNull()
  })

  /**
   * Two caches, because they answer different questions. A failed parse
   * surfacing as a detection would fill the form from a page that gave up
   * nothing and light the badge for a record that does not exist.
   */
  it('never surfaces as a detection', async () => {
    await recordFailedParse(7, aFailedParse(), 1000)

    expect(await getDetectionSummary(7)).toBeNull()
  })

  it('does not displace the detection on the same tab', async () => {
    await recordDetection(7, aReport(), 1000)
    await recordFailedParse(7, aFailedParse(), 2000)

    expect(await getDetectionSummary(7)).not.toBeNull()
    expect(await getFailedParse(7)).not.toBeNull()
  })

  it('is cleared when the tab navigates away', async () => {
    await recordFailedParse(7, aFailedParse(), 1000)
    await forgetTab(7)

    expect(await getFailedParse(7)).toBeNull()
  })

  /**
   * `forgetTab`'s answer drives a badge repaint and a broadcast, and a blank
   * read never painted a badge. Reporting one as a drop would wake the worker
   * into work with nothing to do on every navigation away from an unreadable
   * page.
   */
  it('does not on its own make forgetTab claim it dropped something', async () => {
    await recordFailedParse(7, aFailedParse(), 1000)

    await expect(forgetTab(7)).resolves.toBe(false)
    expect(await getFailedParse(7)).toBeNull()
  })

  it('evicts the oldest once more tabs than the bound have reported', async () => {
    for (let tab = 0; tab <= MAX_CACHED_TABS; tab++) {
      await recordFailedParse(tab, aFailedParse(), 1000 + tab)
    }

    expect(await getFailedParse(0)).toBeNull()
    expect(await getFailedParse(MAX_CACHED_TABS)).not.toBeNull()
  })
})
