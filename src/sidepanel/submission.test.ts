import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../lib/types'
import type { Posting } from '../lib/types'
import { aPosting } from '../test/factories'
import { markApplied } from './submission'

function stored(overrides: Partial<Posting> = {}): Posting {
  return {
    ...aPosting(),
    companyNormalized: 'initech',
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  } as Posting
}

describe('markApplied', () => {
  it('sets the status and dates it', () => {
    // One `stored()` call: the factory mints a fresh id each time, so comparing
    // against a second one would compare two different records.
    const posting = stored({ state: 'viewed', appliedAt: null })

    const input = markApplied(posting, 9_000)

    expect(input.state).toBe('applied')
    expect(input.appliedAt).toBe(9_000)
    // The id is what makes this an edit of the stored record rather than a
    // second copy of it (decision 4).
    expect(input.id).toBe(posting.id)
  })

  it('carries the record’s other fields through untouched', () => {
    const posting = stored({ notes: 'ask about the on-call rota', tags: ['remote'] })

    const input = markApplied(posting, 9_000)

    expect(input.notes).toBe('ask about the on-call rota')
    expect(input.tags).toEqual(['remote'])
    expect(input.company).toBe(posting.company)
    expect(input.url).toBe(posting.url)
  })

  /**
   * The repository owns these, and a caller sending them back is a caller that
   * can move them. `createdAt` is the one that matters most: `upsertPosting`
   * keeps the stored value, so leaving it out is what stops a confirmation from
   * re-dating a posting saved weeks ago.
   */
  it('sends none of the fields the repository owns', () => {
    const input = markApplied(stored(), 9_000) as Record<string, unknown>

    expect(input).not.toHaveProperty('schemaVersion')
    expect(input).not.toHaveProperty('updatedAt')
    expect(input).not.toHaveProperty('createdAt')
  })

  it('leaves a date the user already typed alone', () => {
    const input = markApplied(stored({ state: 'applied', appliedAt: 5_000 }), 9_000)

    expect(input.appliedAt).toBe(5_000)
  })
})
