import { describe, expect, it } from 'vitest'
import { mergeTiers, scoreConfidence } from './merge'
import type { TierResult } from './types'

describe('mergeTiers', () => {
  it('prefers the stronger tier whatever order the results arrive in', () => {
    const results: TierResult[] = [
      { tier: 'meta', fields: { jobTitle: 'Acme - Engineer' } },
      { tier: 'jsonld', fields: { jobTitle: 'Engineer' } },
      { tier: 'dom', fields: { jobTitle: 'Engineer (Remote)' } },
    ]

    // Shuffled input, because the adapter lists its readers in its own order
    // and the ranking must not depend on that.
    const merged = mergeTiers([...results].reverse())

    expect(merged.fields.jobTitle).toBe('Engineer')
    expect(merged.provenance.jobTitle).toBe('jsonld')
  })

  it('lets a weaker tier answer a question the stronger one declined', () => {
    // This is the case that makes per-field merging worth the code. On the real
    // Greenhouse page the state blob has the company and no location, and the
    // DOM has the location — picking one winning tier would throw it away.
    const merged = mergeTiers([
      { tier: 'appstate', fields: { company: 'Discord', location: null } },
      { tier: 'dom', fields: { company: 'Discord Inc', location: 'New York' } },
    ])

    expect(merged.fields).toMatchObject({ company: 'Discord', location: 'New York' })
    expect(merged.provenance).toMatchObject({ company: 'appstate', location: 'dom' })
  })

  it('treats an omitted key and an explicit null as the same silence', () => {
    const omitted = mergeTiers([
      { tier: 'jsonld', fields: {} },
      { tier: 'dom', fields: { company: 'Acme' } },
    ])
    const explicit = mergeTiers([
      { tier: 'jsonld', fields: { company: null } },
      { tier: 'dom', fields: { company: 'Acme' } },
    ])

    expect(omitted.fields.company).toBe('Acme')
    expect(explicit.fields.company).toBe('Acme')
  })

  it('reports nothing found as nulls with no provenance', () => {
    const merged = mergeTiers([])

    expect(merged.fields.company).toBeNull()
    expect(merged.provenance.company).toBeNull()
    expect(scoreConfidence(merged.provenance)).toBe(0)
  })
})

describe('scoreConfidence', () => {
  const none = {
    company: null,
    jobTitle: null,
    location: null,
    workMode: null,
    atsReqId: null,
    salary: null,
  } as const

  it('scores a full JSON-LD read above the same fields read off a link preview', () => {
    const structured = scoreConfidence({ ...none, company: 'jsonld', jobTitle: 'jsonld' })
    const preview = scoreConfidence({ ...none, company: 'meta', jobTitle: 'meta' })

    expect(structured).toBeGreaterThan(preview)
    expect(structured).toBeCloseTo(0.71, 2)
    expect(preview).toBeCloseTo(0.36, 2)
  })

  it('weighs the two fields the record cannot do without above the rest', () => {
    const core = scoreConfidence({ ...none, company: 'jsonld' })
    const extras = scoreConfidence({
      ...none,
      location: 'jsonld',
      workMode: 'jsonld',
      salary: 'jsonld',
      atsReqId: 'jsonld',
    })

    expect(core).toBeGreaterThan(extras)
  })

  it('reaches 1 only when every field came from the strongest tier', () => {
    expect(
      scoreConfidence({
        company: 'jsonld',
        jobTitle: 'jsonld',
        location: 'jsonld',
        workMode: 'jsonld',
        atsReqId: 'jsonld',
        salary: 'jsonld',
      }),
    ).toBe(1)
  })
})
