import { describe, expect, it } from 'vitest'

import {
  buildReport,
  formatBytes,
  formatReport,
  type DiagnosticsInput,
  type PageParse,
} from './diagnostics'
import type { Extraction, FieldName, Tier } from './extract/types'
import type { StatusReport } from './messages'

/**
 * Every string an input can carry, seeded with something that could not occur by
 * accident. The leak tests below assert that none of these reach the output, so
 * a field added upstream and copied here by a careless spread fails a test
 * rather than reaching somebody's clipboard.
 */
const SECRET = {
  company: 'SEEKRIT-COMPANY',
  jobTitle: 'SEEKRIT-TITLE',
  location: 'SEEKRIT-LOCATION',
  salaryRaw: 'SEEKRIT-SALARY',
  reqId: 'SEEKRIT-REQ',
  path: 'SEEKRIT-PATH',
  query: 'SEEKRIT-QUERY',
  credentials: 'SEEKRIT-CREDS',
}

const SECRET_URL = `https://${SECRET.credentials}:pw@boards.greenhouse.io:8443/${SECRET.path}/jobs/4021?gh_src=${SECRET.query}`

function anExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    fields: {
      company: SECRET.company,
      jobTitle: SECRET.jobTitle,
      location: SECRET.location,
      workMode: 'hybrid',
      atsReqId: SECRET.reqId,
      salary: {
        min: 180_000,
        max: 220_000,
        currency: 'USD',
        period: 'year',
        raw: SECRET.salaryRaw,
      },
    },
    provenance: {
      company: 'jsonld',
      jobTitle: 'dom',
      location: 'dom',
      workMode: null,
      atsReqId: null,
      salary: null,
    },
    source: 'greenhouse',
    adapterVersion: 'greenhouse@3',
    confidence: 0.62,
    ...overrides,
  }
}

function aStatus(overrides: Partial<StatusReport> = {}): StatusReport {
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
    ...overrides,
  }
}

function anInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    at: 1_754_870_000_000,
    extensionVersion: '0.0.1',
    url: SECRET_URL,
    status: aStatus(),
    parse: { read: true, parse: anExtraction() },
    ...overrides,
  }
}

/** Every sentinel, so a leak is caught wherever it came from. */
const ALL_SECRETS = Object.values(SECRET)

describe('redaction', () => {
  it('reduces the URL to a hostname, dropping path, query, port and credentials', () => {
    const report = buildReport(anInput())

    expect(report.page).toEqual({ host: 'boards.greenhouse.io', scheme: 'https:' })
  })

  it('lets no input value reach the report object', () => {
    const serialized = JSON.stringify(buildReport(anInput()))

    for (const secret of ALL_SECRETS) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('lets no input value reach the clipboard text', () => {
    const text = formatReport(buildReport(anInput()))

    for (const secret of ALL_SECRETS) {
      expect(text).not.toContain(secret)
    }
  })

  it('keeps the field values out even when every tier answered', () => {
    const provenance = {
      company: 'jsonld',
      jobTitle: 'jsonld',
      location: 'jsonld',
      workMode: 'dom',
      atsReqId: 'appstate',
      salary: 'jsonld',
    } as Record<FieldName, Tier | null>

    const text = formatReport(
      buildReport(anInput({ parse: { read: true, parse: anExtraction({ provenance }) } })),
    )

    for (const secret of ALL_SECRETS) {
      expect(text).not.toContain(secret)
    }
    // The tier names are the point, so prove they survived the redaction that
    // removed everything else — a report that leaked nothing because it reported
    // nothing would pass every assertion above.
    expect(text).toContain('appstate')
  })

  it('does not carry lastBackupAt, which is on the status but is not diagnostic', () => {
    const serialized = JSON.stringify(buildReport(anInput()))

    expect(serialized).not.toContain('lastBackupAt')
    expect(serialized).not.toContain('1754000000000')
  })

  it('reports nulls rather than throwing on a URL that will not parse', () => {
    const report = buildReport(anInput({ url: 'not a url at all' }))

    expect(report.page).toEqual({ host: null, scheme: null })
    expect(formatReport(report)).toContain('page       not reported')
  })

  it('says nothing about the page when no URL was ever reported', () => {
    // The ordinary state of a tab: not a matched board, never right-clicked.
    // Without the `tabs` permission the extension has no URL to redact, and
    // claiming one would be worse than saying so.
    const report = buildReport(
      anInput({ url: null, parse: { read: false, reason: 'not-read' } }),
    )

    expect(report.page).toEqual({ host: null, scheme: null })
    expect(formatReport(report)).toContain('page       not reported')
  })

  it('keeps the scheme, which is what explains a restricted page', () => {
    const report = buildReport(anInput({ url: 'chrome://extensions/' }))

    expect(report.page.scheme).toBe('chrome:')
  })

  it('drops a field the extraction carries that is not a declared field', () => {
    const rogue = anExtraction()
    // A tier that invented a key, or a type that has moved on without this
    // module. Iterating FIELD_NAMES is what makes it a non-event.
    ;(rogue.provenance as Record<string, unknown>).recruiterEmail = SECRET.company

    const serialized = JSON.stringify(
      buildReport(anInput({ parse: { read: true, parse: rogue } })),
    )

    expect(serialized).not.toContain('recruiterEmail')
    expect(serialized).not.toContain(SECRET.company)
  })
})

describe('what the report says', () => {
  it('names the adapter, its version and the coverage score', () => {
    const text = formatReport(buildReport(anInput()))

    expect(text).toContain('greenhouse@3')
    expect(text).toContain('0.62')
  })

  it('reports a field nothing answered as not found', () => {
    const text = formatReport(buildReport(anInput()))

    expect(text).toContain('workMode   not found')
    expect(text).toContain('company    jsonld')
  })

  it('says the parse would have been offered when a title alone was found', () => {
    const provenance = {
      company: null,
      jobTitle: 'meta',
      location: null,
      workMode: null,
      atsReqId: null,
      salary: null,
    } as Record<FieldName, Tier | null>

    const text = formatReport(
      buildReport(anInput({ parse: { read: true, parse: anExtraction({ provenance }) } })),
    )

    expect(text).toContain('offered    yes')
  })

  /**
   * The case the phase exists for. A page the adapters could not read is the one
   * the user is complaining about, and the report has to say *which gate* stayed
   * shut rather than going quiet the way `capture.ts` does.
   */
  it('says why nothing was offered when no tier answered anything', () => {
    const provenance = {
      company: null,
      jobTitle: null,
      location: null,
      workMode: null,
      atsReqId: null,
      salary: null,
    } as Record<FieldName, Tier | null>

    const text = formatReport(
      buildReport(anInput({ parse: { read: true, parse: anExtraction({ provenance }) } })),
    )

    expect(text).toContain('offered    no — needs a company or a job title')
    expect(text).toContain('company    not found')
  })

  it('reports an unreachable page with a reason and no parse block', () => {
    const parse: PageParse = { read: false, reason: 'not-read' }
    const report = buildReport(anInput({ parse }))

    expect(report.parse).toBeNull()
    expect(report.unreachable).toBe('not-read')

    const text = formatReport(report)
    expect(text).toContain('parse      none — not-read')
    // The install half still has to be there: "is this even a healthy install"
    // is the first thing to rule out, and it is the half that survives a page
    // that could not be touched.
    expect(text).toContain('41 postings')
  })

  it('still reports the install when the page was reachable', () => {
    const text = formatReport(buildReport(anInput()))

    expect(text).toContain('v3, data at v3')
    expect(text).toContain('protected (unlimitedStorage)')
  })

  it('calls storage evictable when neither defence holds', () => {
    const text = formatReport(
      buildReport(
        anInput({
          status: aStatus({
            evictionSafe: false,
            storagePersisted: false,
            storageUnlimited: false,
          }),
        }),
      ),
    )

    expect(text).toContain('storage    evictable')
  })

  it('says a migration is running, because it explains a wrong count', () => {
    const text = formatReport(
      buildReport(
        anInput({ status: aStatus({ migrationInProgress: true, dataVersion: 2 }) }),
      ),
    )

    expect(text).toContain('v3, data at v2, migrating')
  })
})

describe('formatBytes', () => {
  it('scales to the unit the number belongs in', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(12_582_912)).toBe('12 MB')
    expect(formatBytes(10_737_418_240)).toBe('10 GB')
  })

  /**
   * Chrome rounds and pads `estimate()` on purpose, to make cross-origin
   * storage fingerprinting harder. Printing every digit would dress a
   * deliberate approximation as a measurement.
   */
  it('keeps a decimal only while the number is small enough to need one', () => {
    expect(formatBytes(5_242_880)).toBe('5.0 MB')
    expect(formatBytes(52_428_800)).toBe('50 MB')
  })

  it('says unknown rather than zero when nothing was reported', () => {
    expect(formatBytes(null)).toBe('unknown')
  })
})

describe('what the report says about disk', () => {
  it('reports usage against quota', () => {
    expect(formatReport(buildReport(anInput()))).toContain('on disk    12 MB of 10 GB')
  })

  it('says unknown when the browser declined to estimate', () => {
    const text = formatReport(
      buildReport(anInput({ status: aStatus({ usageBytes: null, quotaBytes: null }) })),
    )

    expect(text).toContain('on disk    unknown of unknown')
  })
})
