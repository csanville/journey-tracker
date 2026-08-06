import { describe, expect, it } from 'vitest'
import { POSTING_INPUT_FIELDS } from '../lib/types'
import type { Posting } from '../lib/types'
import { aPosting } from '../test/factories'
import {
  EMPTY_DRAFT,
  asDateInput,
  draftErrors,
  draftFromPosting,
  isDirty,
  isSaveable,
  parseAppliedAt,
  parseTags,
  toPostingInput,
  today,
  type Draft,
} from './draft'
import { editContextFor } from './fill'

function draft(overrides: Partial<Draft> = {}): Draft {
  return { ...EMPTY_DRAFT, company: 'Acme, Inc.', jobTitle: 'Staff Engineer', ...overrides }
}

/** A stored record, which `aPosting` does not quite give — it builds an input. */
function stored(overrides: Partial<Posting> = {}): Posting {
  return {
    ...aPosting(),
    companyNormalized: 'initech',
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    schemaVersion: 3,
    createdAt: new Date(2026, 4, 2).getTime(),
    updatedAt: new Date(2026, 4, 2).getTime(),
    ...overrides,
  }
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

  /**
   * `DRAFT_FIELDS` is derived from `EMPTY_DRAFT`, so a new field joins dirty
   * tracking by existing. This pins that, because the failure is silent and
   * expensive: an unwatched field is typed work that a swap would clobber
   * without asking (decision 13).
   */
  it('notices a stage the user set and nothing else', () => {
    expect(isDirty({ ...EMPTY_DRAFT, stage: 'interviewing' })).toBe(true)
    expect(isDirty({ ...EMPTY_DRAFT, outcome: 'rejected' })).toBe(true)
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

  it('carries the stage and outcome an applied record was given', () => {
    const input = toPostingInput(
      draft({
        state: 'applied',
        appliedAt: '2026-03-14',
        stage: 'interviewing',
        outcome: 'rejected',
      }),
      'id-1',
    )

    // The pair a single status enum could not express, which is the reason
    // there are two fields.
    expect(input.stage).toBe('interviewing')
    expect(input.outcome).toBe('rejected')
  })

  it('reads the blank options as nothing heard and still open', () => {
    const input = toPostingInput(
      draft({ state: 'applied', appliedAt: '2026-03-14' }),
      'id-1',
    )

    expect(input.stage).toBeNull()
    expect(input.outcome).toBeNull()
  })

  it('drops stage and outcome from a posting that was only looked at', () => {
    const input = toPostingInput(
      draft({ state: 'viewed', stage: 'offer', outcome: 'accepted' }),
      'id-1',
    )

    expect(input.stage).toBeNull()
    expect(input.outcome).toBeNull()
  })

  it('implies the offer stage when an offer was accepted', () => {
    const input = toPostingInput(
      draft({ state: 'applied', appliedAt: '2026-03-14', outcome: 'accepted' }),
      'id-1',
    )

    expect(input.stage).toBe('offer')
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

describe('draftFromPosting', () => {
  /**
   * The test that matters, and the reason it is written against
   * `POSTING_INPUT_FIELDS` rather than against a list of assertions: a field
   * added to the record later joins this check by existing, not by somebody
   * remembering to come back here.
   *
   * What it pins is the whole of phase 9's claim — that opening a record,
   * touching nothing and saving it leaves the record exactly as it was. A field
   * this pair drops silently would be a field the user loses by looking at it.
   */
  it('round-trips every caller-owned field through the form and back', () => {
    const posting = stored({
      state: 'applied',
      appliedAt: new Date(2026, 2, 14).getTime(),
      stage: 'interviewing',
      outcome: 'rejected',
      resumeUsed: 'backend-2026',
      notes: 'referred by Dana',
      tags: ['remote', 'senior'],
    })

    const asDraft = draftFromPosting(posting)
    const back = toPostingInput(asDraft, posting.id, editContextFor(posting, asDraft))

    for (const field of POSTING_INPUT_FIELDS) {
      // The two derived join keys are the exception, and deliberately so: the
      // repository owns them and re-derives them on the way in, which is why
      // `toPostingInput` does not produce them at all.
      if (field === 'companyNormalized' || field === 'canonicalUrl') continue
      expect({ [field]: back[field] }).toEqual({ [field]: posting[field] })
    }
  })

  it('keeps the id, so an edit is an edit and not a second record', () => {
    const posting = stored()
    const back = toPostingInput(draftFromPosting(posting), posting.id)

    expect(back.id).toBe(posting.id)
  })

  /**
   * The silent-degradation trap. Without `editContextFor` the edit path falls
   * through to `MANUAL_SAVE`, and every extracted record becomes `manual@1` the
   * first time anybody corrects a typo in it — taking with it the only thing
   * that says which records a later adapter fix should replay (decision 6).
   */
  it('keeps the provenance of a record that came off a page', () => {
    const posting = stored({
      source: 'greenhouse',
      sourceConfidence: 0.9,
      adapterVersion: 'greenhouse@3',
    })

    const asDraft = draftFromPosting(posting)
    const back = toPostingInput(asDraft, posting.id, editContextFor(posting, asDraft))

    expect(back.source).toBe('greenhouse')
    expect(back.adapterVersion).toBe('greenhouse@3')
    expect(back.sourceConfidence).toBe(0.9)
  })

  it('turns absent fields into the empty strings the inputs hold', () => {
    const asDraft = draftFromPosting(
      stored({
        location: null,
        workMode: null,
        atsReqId: null,
        salary: null,
        appliedAt: null,
        stage: null,
        outcome: null,
        resumeUsed: null,
        notes: null,
        tags: [],
      }),
    )

    expect(asDraft).toMatchObject({
      location: '',
      workMode: '',
      atsReqId: '',
      salary: '',
      appliedAt: '',
      stage: '',
      outcome: '',
      resumeUsed: '',
      notes: '',
      tags: '',
    })
  })

  /**
   * `appliedAt` is stored as epoch milliseconds and shown as a calendar date, and
   * the conversion happens in local time at both ends. A record applied to late
   * in the evening must not read as the following day, which is what a UTC
   * formatter would do for anyone east of Greenwich.
   */
  it('shows a late-evening applied date as the day it was', () => {
    const at = new Date(2026, 2, 14, 23, 30).getTime()

    expect(draftFromPosting(stored({ appliedAt: at })).appliedAt).toBe('2026-03-14')
    expect(parseAppliedAt('2026-03-14')).toBe(new Date(2026, 2, 14).getTime())
  })

  it('joins tags as the comma-separated text the field holds', () => {
    expect(draftFromPosting(stored({ tags: ['remote', 'senior'] })).tags).toBe(
      'remote, senior',
    )
  })
})

describe('asDateInput', () => {
  it('is the inverse of parseAppliedAt across a local midnight', () => {
    const date = new Date(2026, 11, 31, 22, 15)

    expect(asDateInput(date)).toBe('2026-12-31')
    expect(parseAppliedAt(asDateInput(date))).toBe(new Date(2026, 11, 31).getTime())
  })

  it('is what today() reports', () => {
    const now = new Date(2026, 2, 4)

    expect(today(now)).toBe(asDateInput(now))
  })
})
