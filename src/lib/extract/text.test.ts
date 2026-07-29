import { describe, expect, it } from 'vitest'
import { cleanText, splitOnce } from './text'

describe('cleanText', () => {
  it('collapses the whitespace a board actually emits', () => {
    expect(cleanText('\n      Senior Engineer\n   ')).toBe('Senior Engineer')
    expect(cleanText('Senior  Engineer')).toBe('Senior Engineer')
  })

  it('treats blank and missing as the same absence', () => {
    expect(cleanText('   ')).toBeNull()
    expect(cleanText('')).toBeNull()
    expect(cleanText(null)).toBeNull()
    expect(cleanText(undefined)).toBeNull()
  })

  it('rejects an over-long value rather than truncating it', () => {
    // A selector that matched a container instead of a label produces this.
    // Half of a wrong answer is still wrong, and harder to spot in the form.
    expect(cleanText('x'.repeat(301))).toBeNull()
    expect(cleanText('x'.repeat(300))).toHaveLength(300)
  })
})

describe('splitOnce', () => {
  it('splits a title that has exactly one separator', () => {
    expect(splitOnce('Lever Demo 2 - Software Engineer', / - /)).toEqual([
      'Lever Demo 2',
      'Software Engineer',
    ])
  })

  it('refuses a title with more than one separator', () => {
    // "Acme - Senior Engineer - Remote" has no reading that can be defended:
    // the employer could be the first part or the first two. Guessing here puts
    // a wrong company into a join key (decision 7).
    expect(splitOnce('Acme - Senior Engineer - Remote', / - /)).toBeNull()
  })

  it('refuses a title with no separator, or an empty half', () => {
    expect(splitOnce('Software Engineer', / - /)).toBeNull()
    expect(splitOnce(' - Software Engineer', / - /)).toBeNull()
    expect(splitOnce('Acme - ', / - /)).toBeNull()
    expect(splitOnce(null, / - /)).toBeNull()
  })
})
