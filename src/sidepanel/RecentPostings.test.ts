import { describe, expect, it } from 'vitest'
import { formatWhen } from './RecentPostings'

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
