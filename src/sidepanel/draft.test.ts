import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT,
  draftErrors,
  isDirty,
  isSaveable,
  parseAppliedAt,
  parseTags,
  toPostingInput,
  today,
  type Draft,
} from './draft'

function draft(overrides: Partial<Draft> = {}): Draft {
  return { ...EMPTY_DRAFT, company: 'Acme, Inc.', jobTitle: 'Staff Engineer', ...overrides }
}

describe('isDirty', () => {
  it('is false for an untouched form', () => {
    expect(isDirty(EMPTY_DRAFT)).toBe(false)
  })

  it('is true once any field has content', () => {
    expect(isDirty({ ...EMPTY_DRAFT, notes: 'ask about the on-call rota' })).toBe(true)
  })

  it('ignores whitespace, so tabbing through the form does not count', () => {
    expect(isDirty({ ...EMPTY_DRAFT, company: '   ' })).toBe(false)
  })

  it('compares against a baseline, not against empty', () => {
    // From phase 5 a pristine form is one that still matches what was
    // auto-filled into it (decision 13).
    const filled = draft()

    expect(isDirty(filled, filled)).toBe(false)
    expect(isDirty({ ...filled, notes: 'mine' }, filled)).toBe(true)
  })
})

describe('draftErrors', () => {
  it('requires only what a record cannot be identified without', () => {
    expect(draftErrors(EMPTY_DRAFT)).toEqual({
      company: expect.any(String),
      jobTitle: expect.any(String),
    })
  })

  it('accepts a posting with no URL', () => {
    // A job heard about by email is still worth tracking.
    expect(isSaveable(draft({ url: '' }))).toBe(true)
  })

  it('does not accept whitespace as a value', () => {
    expect(isSaveable(draft({ company: '   ' }))).toBe(false)
  })
})

describe('parseTags', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseTags(' remote , senior ,, ')).toEqual(['remote', 'senior'])
  })

  it('drops duplicates while keeping the order typed', () => {
    expect(parseTags('remote, senior, remote')).toEqual(['remote', 'senior'])
  })

  it('is empty for an empty string', () => {
    expect(parseTags('')).toEqual([])
  })
})

describe('parseAppliedAt', () => {
  it('reads a date input as local midnight', () => {
    const parsed = parseAppliedAt('2026-03-14')
    const date = new Date(parsed!)

    // Parsed as UTC, this would land on the 13th for anyone west of Greenwich.
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(2)
    expect(date.getDate()).toBe(14)
  })

  it('rejects anything that is not a date input value', () => {
    expect(parseAppliedAt('')).toBeNull()
    expect(parseAppliedAt('14/03/2026')).toBeNull()
    expect(parseAppliedAt('not a date')).toBeNull()
  })
})

describe('today', () => {
  it('formats a local date the way a date input expects', () => {
    expect(today(new Date(2026, 2, 4))).toBe('2026-03-04')
  })
})

describe('toPostingInput', () => {
  it('trims what it keeps and nulls what is blank', () => {
    const input = toPostingInput(draft({ company: '  Acme  ', location: '   ' }), 'id-1')

    expect(input.company).toBe('Acme')
    expect(input.location).toBeNull()
    expect(input.id).toBe('id-1')
  })

  it('leaves the join keys for the worker to derive', () => {
    const input = toPostingInput(draft(), 'id-1')

    // A form that guessed at these would be a second place for them to disagree.
    expect(input.companyNormalized).toBeUndefined()
    expect(input.canonicalUrl).toBeUndefined()
  })

  it('keeps salary as typed rather than half-parsing it', () => {
    const input = toPostingInput(draft({ salary: ' $180k – $220k ' }), 'id-1')

    expect(input.salary).toEqual({
      min: null,
      max: null,
      currency: null,
      period: null,
      raw: '$180k – $220k',
    })
  })

  it('has no salary at all when the field is blank', () => {
    expect(toPostingInput(draft({ salary: '  ' }), 'id-1').salary).toBeNull()
  })

  it('records an applied date only once the application has gone in', () => {
    const applied = toPostingInput(
      draft({ state: 'applied', appliedAt: '2026-03-14' }),
      'id-1',
    )
    const viewed = toPostingInput(
      draft({ state: 'viewed', appliedAt: '2026-03-14' }),
      'id-2',
    )

    expect(applied.appliedAt).not.toBeNull()
    // A date on a posting that was only looked at would misreport the funnel
    // (decision 8).
    expect(viewed.appliedAt).toBeNull()
  })

  it('marks the record as hand-entered', () => {
    const input = toPostingInput(draft(), 'id-1')

    expect(input.source).toBe('manual')
    expect(input.sourceConfidence).toBe(1)
  })

  it('generates an id when none is given', () => {
    expect(toPostingInput(draft()).id).toBeTruthy()
  })
})
