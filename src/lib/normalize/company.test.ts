import { describe, expect, it } from 'vitest'
import { normalizeCompany } from './company'

/**
 * Each group is an assertion that every spelling in it is one employer. Written
 * as data because the interesting failures are in the fixtures, not the loop.
 */
const COLLAPSE: Array<{ what: string; variants: string[] }> = [
  {
    what: 'legal suffix and punctuation noise',
    variants: ['Acme, Inc.', 'ACME Inc', 'Acme Incorporated', 'acme inc.', '  Acme   Inc  '],
  },
  {
    what: 'stacked legal forms',
    variants: ['Acme Co., Ltd.', 'Acme Co Ltd', 'ACME CO., LTD', 'Acme'],
  },
  {
    what: 'periods inside an initialism',
    variants: ['Acme S.p.A.', 'Acme SpA', 'Acme S.P.A', 'Acme'],
  },
  {
    what: 'ampersand written both ways',
    variants: ['Johnson & Johnson', 'Johnson and Johnson', 'JOHNSON &  JOHNSON'],
  },
  {
    what: 'a leading article',
    variants: ['The Boeing Company', 'Boeing', 'the boeing co'],
  },
  {
    what: 'accents',
    variants: ['Nestlé', 'Nestle', 'NESTLÉ S.A.'],
  },
  {
    what: 'an apostrophe',
    variants: ["Macy's", 'Macys', "MACY'S, INC."],
  },
  {
    what: 'a hyphenated name',
    variants: ['H-E-B', 'H E B', 'HEB'],
  },
  {
    what: 'an alias',
    variants: ['International Business Machines Corporation', 'IBM', 'I.B.M.'],
  },
  {
    what: 'an alias reached through a suffix',
    variants: ['Ernst & Young LLP', 'Ernst and Young', 'EY'],
  },
  {
    what: 'a German legal form',
    variants: ['Beispiel GmbH', 'BEISPIEL gmbh', 'Beispiel'],
  },
]

/**
 * The half that matters more. Every pair here is two different employers that a
 * more aggressive normalizer would merge, and a merge is the failure with no
 * user-visible symptom.
 */
const DISTINCT: Array<[string, string, string]> = [
  ['a bare name and one with a qualifier', 'Acme', 'Acme Group'],
  ['a division', 'Acme', 'Acme Health'],
  ['holdings is part of the name', 'Acme Inc', 'Acme Holdings'],
  ['labs is part of the name', 'Acme', 'Acme Labs'],
  ['similar spellings', 'Stripe', 'Stripes'],
  ['a shared first word', 'Square', 'Square Enix'],
  ['different aliases', 'PricewaterhouseCoopers', 'Ernst & Young'],
  ['plural is not a legal form', 'Acme Partners', 'Acme'],
]

describe('normalizeCompany', () => {
  describe('collapses', () => {
    for (const { what, variants } of COLLAPSE) {
      it(what, () => {
        const keys = variants.map(normalizeCompany)
        expect(new Set(keys).size, `expected one key, got ${JSON.stringify(keys)}`).toBe(1)
        expect(keys[0]).not.toBe('')
      })
    }
  })

  describe('keeps apart', () => {
    for (const [what, left, right] of DISTINCT) {
      it(what, () => {
        expect(normalizeCompany(left)).not.toBe(normalizeCompany(right))
      })
    }
  })

  it('never strips a name down to nothing', () => {
    // The whole name is a legal form. An empty key here would collapse every
    // such company into one record.
    expect(normalizeCompany('Limited')).toBe('limited')
    expect(normalizeCompany('Inc.')).toBe('inc')
  })

  it('returns an empty key only when there is nothing to key on', () => {
    expect(normalizeCompany('')).toBe('')
    expect(normalizeCompany('   ')).toBe('')
    expect(normalizeCompany('—/—')).toBe('')
  })

  it('keeps non-Latin names rather than erasing them', () => {
    // A separator class of "not ASCII" would reduce these to an empty key and
    // silently merge every such employer.
    expect(normalizeCompany('楽天株式会社')).not.toBe('')
    expect(normalizeCompany('Яндекс')).toBe('яндекс')
  })

  it('is idempotent, so re-normalizing a stored key is a no-op', () => {
    for (const { variants } of COLLAPSE) {
      for (const variant of variants) {
        const once = normalizeCompany(variant)
        expect(normalizeCompany(once)).toBe(once)
      }
    }
  })
})
