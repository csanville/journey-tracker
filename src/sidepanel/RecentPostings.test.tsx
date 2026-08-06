// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Posting } from '../lib/types'
import { aPosting } from '../test/factories'
import { RecentPostings, formatWhen, matches } from './RecentPostings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

/** Local time, so the test means the same thing wherever it runs. */
const at = (year: number, month: number, day: number, hour: number, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime()

describe('formatWhen', () => {
  it('counts calendar days, not elapsed hours', () => {
    // Nine hours apart, but plainly yesterday. Dividing the difference by
    // 86_400_000 called this "today".
    const saved = at(2026, 3, 13, 23, 0)
    const now = at(2026, 3, 14, 8, 0)

    expect(formatWhen(saved, now)).toBe('yesterday')
  })

  it('does not undercount across several nights', () => {
    // 57 hours, which is two 24-hour blocks but three calendar days.
    expect(formatWhen(at(2026, 3, 11, 23, 0), at(2026, 3, 14, 8, 0))).toBe('3 days ago')
  })

  it('says today for earlier the same day', () => {
    expect(formatWhen(at(2026, 3, 14, 1, 0), at(2026, 3, 14, 23, 0))).toBe('today')
  })

  it('tolerates a timestamp slightly in the future', () => {
    // Clock skew between writing and rendering should not read as "-0 days".
    expect(formatWhen(at(2026, 3, 14, 12, 0), at(2026, 3, 14, 11, 59))).toBe('today')
  })

  it('falls back to a date beyond a week', () => {
    const formatted = formatWhen(at(2026, 3, 1, 12, 0), at(2026, 3, 14, 12, 0))

    expect(formatted).not.toMatch(/ago|today|yesterday/)
  })
})

describe('matches', () => {
  const stored = (overrides: Partial<Posting> = {}): Posting => ({
    ...aPosting(),
    companyNormalized: 'initech',
    canonicalUrl: 'https://example.test/1',
    schemaVersion: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  })

  const postings = [
    stored({ id: 'a', company: 'Stripe', jobTitle: 'Senior Backend Engineer' }),
    stored({ id: 'b', company: 'Initech', jobTitle: 'Staff Engineer' }),
    stored({ id: 'c', company: 'Acme, Inc.', jobTitle: 'Data Scientist' }),
  ]

  it('returns everything when nothing is typed', () => {
    // The list has a default job — the recent few — and an empty box must not
    // turn it into a search that found everything by accident.
    expect(matches(postings, '')).toHaveLength(3)
    expect(matches(postings, '   ')).toHaveLength(3)
  })

  it('matches a company regardless of case', () => {
    expect(matches(postings, 'stripe').map((p) => p.id)).toEqual(['a'])
  })

  it('matches the job title too', () => {
    // Half of what someone remembers about a posting is the role, not the
    // employer.
    expect(matches(postings, 'data').map((p) => p.id)).toEqual(['c'])
  })

  it('matches a fragment from the middle of a word', () => {
    expect(matches(postings, 'ngineer').map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('finds nothing rather than everything when nothing matches', () => {
    // The state the empty message has to distinguish from "nothing saved yet".
    expect(matches(postings, 'zzz')).toEqual([])
  })
})

/**
 * The read states, which is the whole of what can go wrong in this list.
 *
 * Phase 3 shipped "Nothing saved yet" beside the panel's own error banner, and
 * phase 7 arrived independently at three states rather than two for the same
 * reason. Filtering adds a fourth — loaded, non-empty, and nothing matches — and
 * it is the one most likely to be told as "you have no records", which is a
 * false statement about somebody's data.
 */
describe('RecentPostings', () => {
  let root: Root | null = null
  let host: HTMLDivElement | null = null

  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = null
    host = null
  })

  const stored = (overrides: Partial<Posting> = {}): Posting => ({
    ...aPosting(),
    companyNormalized: 'initech',
    canonicalUrl: 'https://example.test/1',
    schemaVersion: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  })

  async function render(postings: Posting[] | null, onEdit = vi.fn()) {
    host = document.createElement('div')
    document.body.append(host)

    await act(async () => {
      root = createRoot(host!)
      root.render(<RecentPostings postings={postings} onEdit={onEdit} />)
    })

    return host
  }

  async function search(el: HTMLElement, value: string) {
    const input = el.querySelector('input[type="search"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!

    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('says it is loading rather than that there is nothing', async () => {
    const el = await render(null)

    expect(el.textContent).toContain('Loading')
    expect(el.textContent).not.toContain('Nothing saved yet')
  })

  it('says nothing is saved only when nothing is', async () => {
    const el = await render([])

    expect(el.textContent).toContain('Nothing saved yet')
  })

  it('shows the recent few when nothing is typed', async () => {
    const el = await render(
      Array.from({ length: 8 }, (_, i) => stored({ id: `p-${i}`, company: `Co ${i}` })),
    )

    expect(el.querySelectorAll('.recent__item')).toHaveLength(5)
  })

  it('does not claim the records are gone when a search misses', async () => {
    const el = await render([stored({ company: 'Stripe' })])

    await search(el, 'zzz')

    // The records are all still there. This is the fourth state, and saying
    // "Nothing saved yet" here would be the oldest failure in this project.
    expect(el.textContent).not.toContain('Nothing saved yet')
    expect(el.textContent).toContain('No saved posting matches')
    expect(el.textContent).toContain('1 are stored')
  })

  it('says how much of the whole it is showing', async () => {
    const el = await render([
      stored({ id: 'a', company: 'Stripe' }),
      stored({ id: 'b', company: 'Initech' }),
    ])

    await search(el, 'stripe')

    // A bare count beside a filtered list is a claim about how much the user is
    // looking at, and it would be wrong.
    expect(el.textContent).toContain('1 of 2 saved')
  })

  it('reaches past the recent few once a search is typed', async () => {
    const el = await render(
      Array.from({ length: 8 }, (_, i) => stored({ id: `p-${i}`, company: 'Initech' })),
    )

    await search(el, 'initech')

    // The record somebody wants to record a rejection against is weeks old and
    // is exactly the one the default five would never show.
    expect(el.querySelectorAll('.recent__item')).toHaveLength(8)
  })

  it('hands the whole record back when a row is opened', async () => {
    const onEdit = vi.fn()
    const posting = stored({ company: 'Stripe' })
    const el = await render([posting], onEdit)

    await act(async () => {
      el.querySelector('.recent__open')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    expect(onEdit).toHaveBeenCalledWith(posting)
  })

  it('shows the stage and outcome, which is what a reopened record is for', async () => {
    const el = await render([
      stored({ state: 'applied', stage: 'interviewing', outcome: 'rejected' }),
    ])

    expect(el.textContent).toContain('interviewing')
    expect(el.textContent).toContain('rejected')
  })

  it('says nothing about a stage that has not been reached', async () => {
    // Absent stays absent: no stage is "nothing heard yet", the ordinary state
    // of a recent application, not a thing to go and fix.
    const el = await render([stored({ state: 'applied', stage: null, outcome: null })])

    expect(el.querySelectorAll('.pill--stage')).toHaveLength(0)
    expect(el.querySelectorAll('.pill--outcome')).toHaveLength(0)
  })
})
