// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://careers.acme.com/openings/42" }
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Typed with its arguments so `mock.calls` is inspectable. A bare `vi.fn()` here
 * infers a zero-argument call signature, and every assertion about *what* was
 * reported would then be a cast from an empty tuple.
 */
const send = vi.fn(async (_kind: string, _payload: unknown) => ({}) as never)

vi.mock('../lib/client', () => ({ send }))

const { capture } = await import('./capture')

/**
 * A page with nothing an adapter can read.
 *
 * On a domain no adapter matches, `selectAdapter` falls back to `generic`, whose
 * only tiers are JSON-LD and OpenGraph — so a document with neither yields
 * nothing at all. Note that `<title>` is *not* one of them: `readMeta` reads
 * `og:title`, `twitter:title` and nothing else, because the page title welds the
 * employer to the role in a different order on every board.
 */
function writePage(html: string, path = '/openings/42'): void {
  document.head.innerHTML = ''
  document.body.innerHTML = html
  // Same origin only — jsdom is pinned to the one in the docblock above, and
  // `replaceState` across origins is a SecurityError rather than a navigation.
  history.replaceState(null, '', path)
}

/** The one tag that turns the page above into a posting the generic adapter reads. */
function givePageATitle(title = 'Staff Engineer'): void {
  document.head.innerHTML = `<meta property="og:title" content="${title}" />`
}

/** The ladder's three rungs, driven without waiting for real timers. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) {
    await vi.advanceTimersByTimeAsync(3000)
  }
}

function kinds(): string[] {
  return send.mock.calls.map(([kind]) => kind)
}

/** The report from the nth send, whichever kind it was. */
function reportFrom(index: number): Record<string, unknown> {
  const call = send.mock.calls[index]
  // Thrown rather than asserted away, so a test that stopped reporting fails
  // here saying so instead of on a confusing property assertion below.
  if (!call) throw new Error(`nothing was sent at index ${index}`)

  return (call[1] as { report: Record<string, unknown> }).report
}

beforeEach(() => {
  send.mockClear()
  send.mockResolvedValue({} as never)
  vi.useFakeTimers()
})

describe('a read that finds nothing', () => {
  it('reports a diagnostic once the ladder is exhausted, when asked to', async () => {
    writePage('<p>nothing here</p>')

    capture(location.href, { reportEmpty: true })
    await settle()

    expect(kinds()).toEqual(['diagnostic/report'])

    const report = reportFrom(0)
    expect(report.url).toBe(location.href)
    expect(report.confidence).toBe(0)
  })

  /**
   * The declared content script's case. It runs on every page of three boards
   * without being asked, so reporting its blanks would accumulate a record of
   * ordinary browsing to answer a question nobody asked.
   */
  it('says nothing at all when not asked to', async () => {
    writePage('<p>nothing here</p>')

    capture(location.href)
    await settle()

    expect(send).not.toHaveBeenCalled()
  })

  /**
   * The defect this shape invites. A single-page board changes the URL first and
   * renders some unknown number of milliseconds later, so a diagnostic sent on
   * the first failed rung would report "nothing found" about a page that was
   * merely slow — a confident wrong answer in place of the honest one this
   * feature exists to give.
   */
  it('does not report while rungs remain', async () => {
    writePage('<p>nothing here</p>')

    capture(location.href, { reportEmpty: true })
    await vi.advanceTimersByTimeAsync(300)

    expect(send).not.toHaveBeenCalled()
  })

  it('carries no page source with it', async () => {
    writePage('<p>a recruiter name and a form would live here</p>')

    capture(location.href, { reportEmpty: true })
    await settle()

    // The input to something the user may paste into a public issue. The
    // snapshot is the one thing that must never travel with it, and neither may
    // the fields, empty or not.
    const report = reportFrom(0)
    expect(report).not.toHaveProperty('snapshot')
    expect(report).not.toHaveProperty('fields')
    expect(report).toHaveProperty('provenance')
  })
})

describe('a read that finds a posting', () => {
  it('reports a detection and no diagnostic', async () => {
    writePage('<h1>Staff Engineer</h1>')
    givePageATitle()

    capture(location.href, { reportEmpty: true })
    await settle()

    expect(kinds()).toEqual(['detection/report'])
  })

  it('stops laddering once a rung succeeds', async () => {
    writePage('<h1>Staff Engineer</h1>')
    givePageATitle()

    capture(location.href, { reportEmpty: true })
    await settle()

    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('a page that moved on underneath the ladder', () => {
  /**
   * `runLadder` resolves false both when the rungs ran out and when a newer
   * navigation cancelled it, and only the first is a page worth describing. A
   * diagnostic about a page the tab has already left is the same stale claim the
   * cancellation exists to prevent.
   */
  it('reports nothing when the URL changed before the ladder finished', async () => {
    writePage('<p>nothing here</p>')
    const original = location.href

    capture(original, { reportEmpty: true })
    history.replaceState(null, '', '/openings/99')
    await settle()

    expect(send).not.toHaveBeenCalled()
  })

  it('reports nothing when a newer capture superseded this one', async () => {
    writePage('<p>nothing here</p>')

    capture(location.href, { reportEmpty: true })
    capture(location.href, { reportEmpty: true })
    await settle()

    // The second run owns the page; the first must not also describe it.
    expect(kinds()).toEqual(['diagnostic/report'])
  })
})

describe('when the worker cannot be reached', () => {
  it('does not let a failed send break the page', async () => {
    writePage('<p>nothing here</p>')
    send.mockRejectedValue(new Error('Extension context invalidated'))

    capture(location.href, { reportEmpty: true })

    // The extension must never break a job board — the whole path is wrapped
    // for this, and an unhandled rejection here would surface in the page.
    await expect(settle()).resolves.toBeUndefined()
  })

  /**
   * The defect review found, and the reason the test above did not catch it:
   * asserting that nothing throws says nothing about what was *claimed*.
   *
   * `runLadder` resolves false when no rung found anything and also when every
   * rung threw, and a torn-down MV3 worker makes the second ordinary. Reading
   * that as "the page gave up nothing" reported a page that parsed perfectly as
   * unreadable — and the diagnostic would have carried a full provenance set and
   * printed `offered yes`, contradicting itself in the same breath.
   */
  it('does not call a page unreadable when it was merely undeliverable', async () => {
    writePage('<h1>Staff Engineer</h1>')
    givePageATitle()
    send.mockRejectedValue(new Error('Could not establish connection'))

    capture(location.href, { reportEmpty: true })
    await settle()

    // Three rungs tried to deliver a detection and failed. None of them is
    // grounds for saying the adapters found nothing.
    expect(kinds()).toEqual(['detection/report', 'detection/report', 'detection/report'])
    expect(kinds()).not.toContain('diagnostic/report')
  })

  it('still reports a blank read when delivery is working', async () => {
    writePage('<p>nothing here</p>')

    capture(location.href, { reportEmpty: true })
    await settle()

    // The control for the case above: a page that really did give up nothing
    // never reaches `send` on the detection path at all.
    expect(kinds()).toEqual(['diagnostic/report'])
  })
})
