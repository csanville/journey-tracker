import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../types'
import type { Posting, Snapshot } from '../types'
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  buildBundle,
  parseBundle,
  validatePosting,
  validateSnapshot,
} from './bundle'

/** A stored record, as it would come back out of the database. */
function aRecord(overrides: Partial<Posting> = {}): Posting {
  return {
    id: 'rec-1',
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    company: 'Initech',
    companyNormalized: 'initech',
    jobTitle: 'Staff Engineer',
    location: 'Austin, TX',
    workMode: 'hybrid',
    atsReqId: 'REQ-4021',
    salary: {
      min: 180_000,
      max: 220_000,
      currency: 'USD',
      period: 'year',
      raw: '$180,000 — $220,000 a year',
    },
    url: 'https://boards.greenhouse.io/initech/jobs/4021',
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    source: 'greenhouse',
    sourceConfidence: 0.8,
    adapterVersion: 'greenhouse@1',
    state: 'applied',
    appliedAt: 1_700_000_400_000,
    resumeUsed: 'backend-2026',
    notes: 'Referred by Milton',
    tags: ['backend', 'remote-ok'],
    ...overrides,
  }
}

function aSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    postingId: 'rec-1',
    capturedAt: 1_700_000_000_000,
    adapterVersion: 'greenhouse@1',
    trimmedSource: '<html><title>Staff Engineer</title></html>',
    truncated: false,
    ...overrides,
  }
}

describe('buildBundle', () => {
  it('carries records and pages in a full bundle', () => {
    const bundle = buildBundle('full', [aRecord()], [aSnapshot()], 42)

    expect(bundle.format).toBe(BUNDLE_FORMAT)
    expect(bundle.formatVersion).toBe(BUNDLE_FORMAT_VERSION)
    expect(bundle.schemaVersion).toBe(SCHEMA_VERSION)
    expect(bundle.exportedAt).toBe(42)
    expect(bundle.postings).toHaveLength(1)
    expect(bundle.snapshots).toHaveLength(1)
  })

  // The PII half of decision 6. A lean file that leaked snapshots would look
  // fine until somebody shared one.
  it('drops pages from a lean bundle even when handed them', () => {
    const bundle = buildBundle('lean', [aRecord()], [aSnapshot()], 42)

    expect(bundle.variant).toBe('lean')
    expect(bundle.snapshots).toEqual([])
  })
})

describe('parseBundle', () => {
  const round = (bundle: unknown) => parseBundle(JSON.stringify(bundle))

  it('reads back what buildBundle wrote', () => {
    const original = buildBundle('full', [aRecord()], [aSnapshot()], 42)
    const result = round(original)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.parsed.rejected).toEqual([])
    expect(result.parsed.bundle.postings[0]).toEqual(aRecord())
    expect(result.parsed.bundle.snapshots[0]).toEqual(aSnapshot())
  })

  describe('refuses the whole file when', () => {
    it('it is not JSON', () => {
      expect(parseBundle('not json at all')).toMatchObject({ ok: false })
    })

    it('it is somebody else’s export', () => {
      const result = round({ format: 'other-tool', formatVersion: 1, schemaVersion: 1 })

      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.error).toMatch(/not a JourneyTracker export/)
    })

    it('the envelope is newer than this build reads', () => {
      const result = round({
        format: BUNDLE_FORMAT,
        formatVersion: BUNDLE_FORMAT_VERSION + 1,
        schemaVersion: SCHEMA_VERSION,
        postings: [],
      })

      expect(result).toMatchObject({ ok: false })
    })

    it('the envelope version is missing or not a number', () => {
      expect(
        round({ format: BUNDLE_FORMAT, schemaVersion: SCHEMA_VERSION, postings: [] }),
      ).toMatchObject({ ok: false })
    })
    /**
     * The same refusal `runPendingMigrations` makes. Loading a previous build
     * is ordinary here, and importing records it cannot understand would let
     * their shape be overwritten later by the older one.
     */
    it('the records are from a newer build', () => {
      const result = round({
        format: BUNDLE_FORMAT,
        formatVersion: BUNDLE_FORMAT_VERSION,
        schemaVersion: SCHEMA_VERSION + 1,
        postings: [aRecord()],
      })

      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.error).toMatch(/newer build/)
    })
  })

  /**
   * Refuse what cannot be opened, not what this build did not write. The whole
   * reason the envelope is versioned apart from the records is that an importer
   * can take a file older than itself — testing `!==` would orphan every backup
   * on disk at the first bump, for a format whose purpose is surviving this
   * extension.
   */
  it('accepts an envelope older than this build', () => {
    const result = round({
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION - 1,
      schemaVersion: SCHEMA_VERSION,
      postings: [aRecord()],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.parsed.bundle.postings).toHaveLength(1)
  })

  /**
   * One bad row is not a reason to abandon a restore — but a dropped row that
   * nobody is told about is the worst thing this code can do, so every one of
   * them comes back with a reason attached.
   */
  it('rejects records one at a time and keeps the rest', () => {
    const result = round({
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      postings: [
        aRecord(),
        { id: 'rec-2', jobTitle: 'No company here' },
        aRecord({ id: 'rec-3' }),
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.parsed.bundle.postings.map((p) => p.id)).toEqual(['rec-1', 'rec-3'])
    expect(result.parsed.rejected).toEqual([{ at: 'rec-2', reason: 'no company' }])
  })

  it('treats a missing snapshot list as an empty one', () => {
    const result = round({
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      postings: [],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.parsed.bundle.snapshots).toEqual([])
  })
})

describe('validatePosting', () => {
  it('needs an id, a company and a title', () => {
    expect(validatePosting({ ...aRecord(), id: '  ' })).toBe('no id')
    expect(validatePosting({ ...aRecord(), company: '' })).toBe('no company')
    expect(validatePosting({ ...aRecord(), jobTitle: undefined })).toBe('no job title')
    expect(validatePosting('a string')).toBe('not an object')
  })

  it('needs a created date, since a record with no age cannot be listed', () => {
    expect(validatePosting({ ...aRecord(), createdAt: 'yesterday' })).toBe(
      'no created date',
    )
    // `NaN` is the one number that would pass every later check and then poison
    // a sort, so it is refused here rather than stored.
    expect(validatePosting({ ...aRecord(), createdAt: Number.NaN })).toBe('no created date')
  })

  it('repairs what can be repaired rather than losing the record', () => {
    const result = validatePosting({
      ...aRecord(),
      updatedAt: undefined,
      tags: null,
      workMode: 'lunar',
      sourceConfidence: 12,
      location: '',
    })

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return

    // An absent `updatedAt` falls back to creation rather than to now: a
    // restore that stamped today would reorder the user's whole list.
    expect(result.updatedAt).toBe(aRecord().createdAt)
    expect(result.tags).toEqual([])
    expect(result.workMode).toBeNull()
    expect(result.sourceConfidence).toBe(1)
    expect(result.location).toBeNull()
  })

  /**
   * A record stamped above the current version would read as "written by a
   * newer build" forever after — the state `runPendingMigrations` refuses to
   * open at all. The envelope has already been checked by this point, so a
   * record claiming more is a hand-edited file.
   */
  it('caps a record’s schema version at what this build understands', () => {
    const result = validatePosting({ ...aRecord(), schemaVersion: 99 })

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return

    expect(result.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('drops an applied date from a record that was only viewed', () => {
    const result = validatePosting({ ...aRecord(), state: 'viewed' })

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return

    expect(result.appliedAt).toBeNull()
  })

  // Five nulls in a trench coat: `salary !== null` would be true and every
  // caller that checks it would be misled.
  it('treats an empty salary object as no salary', () => {
    const result = validatePosting({
      ...aRecord(),
      salary: { min: null, max: null, currency: null, period: null, raw: null },
    })

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return

    expect(result.salary).toBeNull()
  })
})

describe('validateSnapshot', () => {
  it('needs a posting to belong to and a page to hold', () => {
    expect(validateSnapshot({ ...aSnapshot(), postingId: '' })).toBe('no posting id')
    expect(validateSnapshot({ ...aSnapshot(), trimmedSource: '' })).toBe('no page source')
  })

  it('keeps the truncation marker, since a cut page must not look complete', () => {
    const result = validateSnapshot({ ...aSnapshot(), truncated: true })

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return

    expect(result.truncated).toBe(true)
  })
})
