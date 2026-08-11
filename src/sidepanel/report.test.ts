import { describe, expect, it } from 'vitest'

import type { CachedFailedParse, DetectionSummary } from '../lib/detection'
import { formatReport } from '../lib/diagnostics'
import type { FieldName, Tier } from '../lib/extract/types'
import type { StatusReport } from '../lib/messages'
import { panelReport, type ReportInput } from './report'

function provenance(overrides: Partial<Record<FieldName, Tier>> = {}) {
  return {
    company: null,
    jobTitle: null,
    location: null,
    workMode: null,
    atsReqId: null,
    salary: null,
    ...overrides,
  } as Record<FieldName, Tier | null>
}

function aDetection(overrides: Partial<DetectionSummary> = {}): DetectionSummary {
  return {
    detectionId: 'det-1',
    url: 'https://job-boards.greenhouse.io/otter/jobs/8355059002?gh_src=abc',
    source: 'greenhouse',
    adapterVersion: 'greenhouse@3',
    confidence: 0.82,
    fields: {
      company: 'Otter',
      jobTitle: 'Staff Engineer',
      location: 'Remote',
      workMode: 'remote',
      atsReqId: null,
      salary: null,
    },
    provenance: provenance({ company: 'appstate', jobTitle: 'appstate' }),
    capturedAt: 1_754_000_000_000,
    snapshotBytes: 4096,
    ...overrides,
  }
}

function aDiagnostic(overrides: Partial<CachedFailedParse> = {}): CachedFailedParse {
  return {
    url: 'https://careers.acme.com/openings/42',
    source: 'generic',
    adapterVersion: 'generic@1',
    confidence: 0,
    provenance: provenance(),
    capturedAt: 1_754_000_000_000,
    ...overrides,
  }
}

function aStatus(): StatusReport {
  return {
    schemaVersion: 3,
    dataVersion: 3,
    migrationInProgress: false,
    storagePersisted: false,
    storageUnlimited: true,
    evictionSafe: true,
    postingCount: 41,
    snapshotCount: 39,
    usageBytes: 12_582_912,
    quotaBytes: 10_737_418_240,
    lastBackupAt: 1_754_000_000_000,
  }
}

function anInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    status: aStatus(),
    detection: null,
    diagnostic: null,
    extensionVersion: '0.0.1',
    at: 1_754_870_000_000,
    ...overrides,
  }
}

describe('panelReport', () => {
  it('describes a page that parsed', () => {
    const report = panelReport(anInput({ detection: aDetection() }))

    expect(report.parse?.adapterVersion).toBe('greenhouse@3')
    expect(report.page.host).toBe('job-boards.greenhouse.io')
    expect(report.unreachable).toBeNull()
  })

  it('describes a page that gave up nothing', () => {
    const report = panelReport(anInput({ diagnostic: aDiagnostic() }))

    expect(report.parse?.adapterVersion).toBe('generic@1')
    expect(report.page.host).toBe('careers.acme.com')
  })

  /**
   * A tab can hold both: a board that renders late fails one read and succeeds
   * the next, and only navigation clears them together. They are not rival
   * observations of one event — the detection means the page *was* read — so
   * reporting the failure alongside it would call the extension broken on a page
   * it had already parsed.
   */
  it('prefers the detection when a tab holds both', () => {
    const report = panelReport(
      anInput({ detection: aDetection(), diagnostic: aDiagnostic() }),
    )

    expect(report.parse?.adapterVersion).toBe('greenhouse@3')
    expect(report.page.host).toBe('job-boards.greenhouse.io')
  })

  /**
   * The case review found. A matched board that navigates without a page load —
   * Ashby is one — never fires `onUpdated`, so `forgetTab` never runs: a
   * detection for posting A survives while the user clicks through to posting B
   * and right-clicks it. Preferring the detection unconditionally described A,
   * with `offered yes`, on the exact page being reported as unreadable.
   */
  it('prefers the newer entry when the two describe different pages', () => {
    const report = panelReport(
      anInput({
        detection: aDetection({ capturedAt: 1_000 }),
        diagnostic: aDiagnostic({ capturedAt: 2_000 }),
      }),
    )

    expect(report.parse?.adapterVersion).toBe('generic@1')
    expect(report.page.host).toBe('careers.acme.com')
  })

  it('keeps the detection when it is the newer of two different pages', () => {
    const report = panelReport(
      anInput({
        detection: aDetection({ capturedAt: 2_000 }),
        diagnostic: aDiagnostic({ capturedAt: 1_000 }),
      }),
    )

    expect(report.parse?.adapterVersion).toBe('greenhouse@3')
  })

  /**
   * The URL and the parse have to come from the *same* entry. Taking the host
   * from one and the adapter from the other is how a report names one page and
   * describes another, which is worse than either alone.
   */
  it('takes the host and the parse from one entry, never a blend', () => {
    const report = panelReport(
      anInput({
        detection: aDetection({ capturedAt: 1_000 }),
        diagnostic: aDiagnostic({ capturedAt: 2_000 }),
      }),
    )

    expect(report.page.host).toBe('careers.acme.com')
    expect(report.parse?.source).toBe('generic')
  })

  it('says nothing has read the page when neither reported', () => {
    const report = panelReport(anInput())

    expect(report.parse).toBeNull()
    expect(report.unreachable).toBe('not-read')
    // Not a failure to redact a URL — there is no URL. Without the `tabs`
    // permission the only ones the extension ever learns are those a content
    // script reported about itself.
    expect(report.page).toEqual({ host: null, scheme: null })
  })

  it('still reports the install when nothing has read the page', () => {
    const text = formatReport(panelReport(anInput()))

    expect(text).toContain('41 postings')
    expect(text).toContain('v3, data at v3')
  })

  /**
   * The state a user would most want to paste into an issue, and the one the
   * first version could not produce a report for at all — the section was gated
   * on a successful `status` round trip.
   */
  it('reports the worker not answering, rather than reporting nothing', () => {
    const text = formatReport(panelReport(anInput({ status: null })))

    expect(text).toContain('worker     no answer — status could not be read')
    expect(text).toContain('JourneyTracker diagnostics')
  })

  it('still describes the page when the worker did not answer', () => {
    const text = formatReport(
      panelReport(anInput({ status: null, diagnostic: aDiagnostic() })),
    )

    expect(text).toContain('careers.acme.com')
    expect(text).toContain('generic@1')
  })

  /**
   * The panel holds the whole `DetectionSummary`, fields included, and hands it
   * to a builder whose parameter cannot carry them. This is the assertion that
   * the narrowing actually holds at the one call site that has the values.
   */
  it('carries no field value out of a detection it was handed', () => {
    const text = formatReport(panelReport(anInput({ detection: aDetection() })))

    expect(text).not.toContain('Otter')
    expect(text).not.toContain('Staff Engineer')
    expect(text).not.toContain('Remote')
    // And nothing of the URL past the host.
    expect(text).not.toContain('8355059002')
    expect(text).not.toContain('gh_src')
    // The tier names are what it is for.
    expect(text).toContain('appstate')
  })
})
