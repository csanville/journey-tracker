import { describe, expect, it } from 'vitest'
import {
  boardOf,
  formatRate,
  funnel,
  overTime,
  perBoard,
  startOfMonth,
  startOfWeek,
} from './aggregate'
import type { Posting } from '../types'

/** Local time, so the test means the same thing wherever it runs. */
const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour).getTime()

let counter = 0

/**
 * Only the fields the aggregation reads. A full `Posting` here would be sixteen
 * irrelevant lines per case and would hide which four actually drive the result.
 */
function record(overrides: Partial<Posting> = {}): Posting {
  return {
    id: `p-${counter++}`,
    createdAt: at(2026, 3, 2),
    updatedAt: at(2026, 3, 2),
    state: 'viewed',
    appliedAt: null,
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    ...overrides,
  } as Posting
}

describe('funnel', () => {
  it('splits the record set in two and divides', () => {
    const result = funnel([
      record({ state: 'viewed' }),
      record({ state: 'viewed' }),
      record({ state: 'applied' }),
      record({ state: 'applied' }),
    ])

    expect(result).toEqual({ tracked: 4, viewed: 2, applied: 2, appliedRate: 0.5 })
  })

  it('has no rate to report over an empty database', () => {
    // Zero percent is a finding — it says you applied to nothing. An empty
    // store has not earned the right to say it.
    expect(funnel([]).appliedRate).toBeNull()
    expect(formatRate(funnel([]).appliedRate)).toBe('—')
  })

  it('counts every record in exactly one state', () => {
    const postings = [record(), record({ state: 'applied' }), record()]
    const result = funnel(postings)

    expect(result.viewed + result.applied).toBe(result.tracked)
    expect(result.tracked).toBe(postings.length)
  })
})

describe('overTime', () => {
  const now = at(2026, 3, 14) // a Saturday

  it('ends at today even when the newest record is old', () => {
    // A chart that ends at the last record hides a six-week gap, which is
    // exactly the thing worth seeing.
    const result = overTime([record({ createdAt: at(2026, 1, 20) })], { limit: 12, now })

    expect(result.buckets).toHaveLength(12)
    expect(result.buckets.at(-1)!.start).toBe(startOfWeek(now))
  })

  it('leaves empty weeks as zeroes rather than as missing columns', () => {
    const result = overTime([record({ createdAt: at(2026, 3, 10) })], { limit: 4, now })

    expect(result.buckets.map((b) => b.tracked)).toEqual([0, 0, 0, 1])
  })

  it('counts tracking and applying as separate series', () => {
    // Tracked in one week, applied two weeks later: one record, two buckets.
    const result = overTime(
      [
        record({
          createdAt: at(2026, 2, 24),
          state: 'applied',
          appliedAt: at(2026, 3, 10),
        }),
      ],
      { limit: 4, now },
    )

    expect(result.buckets.map((b) => b.tracked)).toEqual([0, 1, 0, 0])
    expect(result.buckets.map((b) => b.applied)).toEqual([0, 0, 0, 1])
  })

  it('reports an applied record that carries no date rather than dropping it', () => {
    // The form sets `state` and `appliedAt` from two different controls, and an
    // imported record may predate the pairing. This record is in the funnel's
    // `applied` and cannot go on a timeline; silently omitting it would make
    // the chart disagree with the funnel with no way to tell which one lied.
    const result = overTime([record({ state: 'applied', appliedAt: null })], {
      limit: 4,
      now,
    })

    expect(result.appliedWithoutDate).toBe(1)
    expect(result.buckets.every((b) => b.applied === 0)).toBe(true)
  })

  it('counts what falls off the back of the window', () => {
    const result = overTime(
      [
        record({ createdAt: at(2025, 6, 1) }),
        record({ createdAt: at(2025, 6, 2), state: 'applied', appliedAt: at(2025, 6, 3) }),
        record({ createdAt: at(2026, 3, 10) }),
      ],
      { limit: 4, now },
    )

    expect(result.beforeWindow).toEqual({ tracked: 2, applied: 1 })
    expect(result.buckets.reduce((n, b) => n + b.tracked, 0)).toBe(1)
  })

  it('counts an application older than the record that carries it', () => {
    // Back-filling: saved today, applied to months ago. The two timestamps are
    // placed independently, so the residuals genuinely diverge — tracked is in
    // a visible bucket while applied is not. Anything reading only one of them
    // will drop the other.
    const result = overTime(
      [record({ createdAt: at(2026, 3, 10), state: 'applied', appliedAt: at(2025, 9, 1) })],
      { limit: 4, now },
    )

    expect(result.beforeWindow).toEqual({ tracked: 0, applied: 1 })
    expect(result.buckets.reduce((n, b) => n + b.tracked, 0)).toBe(1)
    expect(result.buckets.reduce((n, b) => n + b.applied, 0)).toBe(0)
  })

  it('accounts for every record exactly once', () => {
    const postings = [
      record({ createdAt: at(2026, 3, 10), state: 'applied', appliedAt: at(2026, 3, 11) }),
      record({ createdAt: at(2026, 3, 3), state: 'applied', appliedAt: null }),
      record({ createdAt: at(2024, 1, 1) }),
      record({ createdAt: at(2026, 3, 12) }),
    ]
    const result = overTime(postings, { limit: 4, now })

    const trackedShown = result.buckets.reduce((n, b) => n + b.tracked, 0)
    const appliedShown = result.buckets.reduce((n, b) => n + b.applied, 0)

    expect(trackedShown + result.beforeWindow.tracked).toBe(postings.length)
    expect(appliedShown + result.beforeWindow.applied + result.appliedWithoutDate).toBe(
      funnel(postings).applied,
    )
  })

  it('puts a hand-typed future date in the newest bucket instead of nowhere', () => {
    const result = overTime(
      [
        record({
          state: 'applied',
          appliedAt: at(2026, 4, 20),
          createdAt: at(2026, 3, 10),
        }),
      ],
      { limit: 4, now },
    )

    expect(result.buckets.at(-1)!.applied).toBe(1)
  })

  it('steps by the calendar so a daylight-saving week is still one week', () => {
    // In a zone that observes it, DST begins 8 March 2026 and that week is 23
    // hours short of seven days: stepping back by a fixed 7 * 86_400_000 from
    // Monday the 9th lands at 23:00 on Sunday the 1st, which normalizes to the
    // week of 23 February and drops the week of 2 March off the axis entirely.
    // Vacuous rather than failing under TZ=UTC; the boundaries below are still
    // the assertion worth having.
    const result = overTime([], { limit: 3, now: at(2026, 3, 14) })

    expect(result.buckets.map((b) => b.start)).toEqual([
      startOfWeek(at(2026, 2, 23)),
      startOfWeek(at(2026, 3, 2)),
      startOfWeek(at(2026, 3, 9)),
    ])
  })

  it('buckets by month when asked', () => {
    const result = overTime([record({ createdAt: at(2026, 1, 15) })], {
      size: 'month',
      limit: 3,
      now,
    })

    expect(result.buckets.map((b) => b.start)).toEqual([
      startOfMonth(at(2026, 1, 1)),
      startOfMonth(at(2026, 2, 1)),
      startOfMonth(at(2026, 3, 1)),
    ])
    expect(result.buckets.at(0)?.tracked).toBe(1)
  })
})

describe('startOfWeek', () => {
  it('starts weeks on Monday', () => {
    // Sunday 15 March 2026 belongs to the week beginning Monday the 9th, not
    // to the one starting that day. `getDay()` is Sunday-zero and gets this
    // backwards without the shift.
    expect(startOfWeek(at(2026, 3, 15))).toBe(startOfWeek(at(2026, 3, 9)))
    expect(new Date(startOfWeek(at(2026, 3, 15))).getDate()).toBe(9)
  })

  it('normalizes to local midnight', () => {
    expect(new Date(startOfWeek(at(2026, 3, 11, 23))).getHours()).toBe(0)
  })
})

describe('boardOf', () => {
  it('names the boards it knows', () => {
    expect(boardOf('https://boards.greenhouse.io/initech/jobs/4021')).toBe('Greenhouse')
    expect(boardOf('https://jobs.lever.co/initech/abc')).toBe('Lever')
    expect(boardOf('https://initech.wd1.myworkdayjobs.com/en-US/External/job/x')).toBe(
      'Workday',
    )
  })

  it('keeps a company subdomain with its board', () => {
    // A company's own Greenhouse host is Greenhouse; its own row would split
    // one board across two lines.
    expect(boardOf('https://initech.greenhouse.io/jobs/4021')).toBe('Greenhouse')
  })

  it('falls back to the bare host for anything else', () => {
    expect(boardOf('https://careers.initech.com/jobs/4021')).toBe('careers.initech.com')
    expect(boardOf('https://www.initech.com/jobs/4021')).toBe('initech.com')
  })

  it('has no board for something that is not a URL', () => {
    expect(boardOf('')).toBeNull()
    expect(boardOf('typed in by hand')).toBeNull()
  })
})

describe('perBoard', () => {
  const gh = (state: Posting['state']) =>
    record({ state, canonicalUrl: 'https://boards.greenhouse.io/a/jobs/1' })
  const lever = (state: Posting['state']) =>
    record({ state, canonicalUrl: 'https://jobs.lever.co/a/b' })

  it('ranks by applications sent, not by records tracked', () => {
    // Forty views and no applications is not where the effort is paying off,
    // however long the bar would be.
    const result = perBoard([
      gh('viewed'),
      gh('viewed'),
      gh('viewed'),
      lever('applied'),
      lever('viewed'),
    ])

    expect(result.rows.map((r) => r.board)).toEqual(['Lever', 'Greenhouse'])
    expect(result.rows[0]).toEqual({
      board: 'Lever',
      tracked: 2,
      applied: 1,
      appliedRate: 0.5,
    })
  })

  it('breaks a tie by name so the order is stable', () => {
    const result = perBoard([gh('applied'), lever('applied')])

    expect(result.rows.map((r) => r.board)).toEqual(['Greenhouse', 'Lever'])
  })

  it('keeps records with no usable URL out of the rows and counts them', () => {
    const result = perBoard([gh('applied'), record({ canonicalUrl: '', state: 'applied' })])

    expect(result.rows).toHaveLength(1)
    expect(result.unattributed).toEqual({ tracked: 1, applied: 1 })
  })

  it('accounts for every record exactly once', () => {
    const postings = [
      gh('applied'),
      gh('viewed'),
      lever('viewed'),
      record({ canonicalUrl: '' }),
    ]
    const result = perBoard(postings)

    const inRows = result.rows.reduce((n, r) => n + r.tracked, 0)
    expect(inRows + result.unattributed.tracked).toBe(postings.length)
  })

  it('has no rows at all for an empty database', () => {
    expect(perBoard([])).toEqual({ rows: [], unattributed: { tracked: 0, applied: 0 } })
  })
})

describe('formatRate', () => {
  it('renders a dash rather than a misleading zero', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0)).toBe('0%')
  })

  it('rounds to whole percent', () => {
    expect(formatRate(1 / 3)).toBe('33%')
    expect(formatRate(1)).toBe('100%')
  })
})
