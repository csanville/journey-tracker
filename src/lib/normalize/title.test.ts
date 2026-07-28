import { describe, expect, it } from 'vitest'
import { normalizeTitle } from './title'

const SAME: Array<[what: string, left: string, right: string]> = [
  ['case', 'Senior Software Engineer', 'senior software engineer'],
  ['surrounding and repeated whitespace', '  Staff  Engineer ', 'Staff Engineer'],
  ['a hyphen against a space', 'Full-Stack Engineer', 'Full Stack Engineer'],
  ['a comma', 'Engineer, Platform', 'Engineer Platform'],
  ['an apostrophe', "Developer's Advocate", 'Developers Advocate'],
  ['a non-breaking space', 'Staff\u00a0Engineer', 'Staff Engineer'],
  ['an en dash against a hyphen', 'Engineer \u2013 Platform', 'Engineer - Platform'],
]

/**
 * The half that matters. Every pair here is two postings a person would want
 * kept apart, and each names something this normalizer could have been tempted
 * to fold away.
 */
const DIFFERENT: Array<[what: string, left: string, right: string]> = [
  ['seniority', 'Senior Software Engineer', 'Software Engineer'],
  ['a level', 'Software Engineer II', 'Software Engineer III'],
  ['a parenthetical that names the arrangement', 'Engineer (Remote)', 'Engineer (Hybrid)'],
  ['a team in the title', 'Engineer, Payments', 'Engineer, Identity'],
  ['a different role entirely', 'Product Designer', 'Product Manager'],
]

describe('normalizeTitle', () => {
  describe('folds', () => {
    for (const [what, left, right] of SAME) {
      it(what, () => {
        expect(normalizeTitle(left)).toBe(normalizeTitle(right))
      })
    }
  })

  describe('keeps apart', () => {
    for (const [what, left, right] of DIFFERENT) {
      it(what, () => {
        expect(normalizeTitle(left)).not.toBe(normalizeTitle(right))
      })
    }
  })

  it('is empty only when there is nothing to key on', () => {
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle('   ')).toBe('')
    // An empty key must never be treated as a match; `findDuplicate` checks.
    expect(normalizeTitle('—')).toBe('')
  })

  it('is idempotent', () => {
    for (const [, left] of [...SAME, ...DIFFERENT]) {
      const once = normalizeTitle(left)
      expect(normalizeTitle(once)).toBe(once)
    }
  })
})
