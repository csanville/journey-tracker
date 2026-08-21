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

/**
 * The iCIMS shape: a shell with the posting one frame down.
 *
 * Real jsdom frames rather than a stubbed `contentDocument`, for the reason
 * `frames.test.ts` gives — and here for a second one. What is being asserted is
 * that the *reported URL* stays the page's while the *fields* come from
 * somewhere else, and a fake frame would let both come from the same place
 * without the test noticing.
 */
describe('a posting inside a same-origin frame', () => {
  function frameWith(html: string): Document {
    const frame = document.createElement('iframe')
    document.body.append(frame)

    const inner = frame.contentDocument
    if (!inner) throw new Error('jsdom gave this frame no document')
    inner.head.innerHTML = '<meta property="og:title" content="Staff Engineer" />'
    inner.body.innerHTML = html

    return inner
  }

  it('reads the frame when the page itself has nothing', async () => {
    writePage('<p>iCIMS Careers Portal</p>')
    frameWith('<h1>Staff Engineer</h1>')

    capture(location.href, { reportEmpty: true })
    await settle()

    expect(kinds()).toEqual(['detection/report'])
    expect(reportFrom(0).fields).toMatchObject({ jobTitle: 'Staff Engineer' })
  })

  /**
   * The whole reason this is done from the top frame instead of with
   * `all_frames`.
   *
   * iCIMS builds the frame's URL with the viewport in it —
   * `?…&width=1506&height=500&in_iframe=1` — and `url.ts` is a blocklist, so
   * those survive canonicalization. A frame reporting its own `location.href`
   * would save one posting as a different record per window size, and none of
   * them would match the URL the user sees or pastes.
   */
  it('reports the page’s URL and not the frame’s', async () => {
    writePage('<p>iCIMS Careers Portal</p>')
    frameWith('<h1>Staff Engineer</h1>')

    capture(location.href, { reportEmpty: true })
    await settle()

    // The kind is asserted first and it is not a formality: without the frame
    // read this whole file passes with `url` correct, because a *diagnostic*
    // carries the page's URL too. Run against the unfixed code, the version of
    // this test that checked only the URL passed while reporting that the page
    // was unreadable.
    expect(kinds()).toEqual(['detection/report'])
    expect(reportFrom(0).fields).toMatchObject({ jobTitle: 'Staff Engineer' })
    expect(reportFrom(0).url).toBe(location.href)
    expect(String(reportFrom(0).url)).not.toContain('width=')
  })

  /**
   * Decision 6 asks a snapshot to be able to reproduce the record attached to
   * it. A snapshot of the shell could reproduce nothing at all.
   */
  it('snapshots the document the fields came out of', async () => {
    writePage('<p>iCIMS Careers Portal</p>')
    frameWith('<h1 data-marker="in-the-frame">Staff Engineer</h1>')

    capture(location.href, { reportEmpty: true })
    await settle()

    const snapshot = reportFrom(0).snapshot as { trimmedSource: string }
    expect(snapshot.trimmedSource).toContain('in-the-frame')
    expect(snapshot.trimmedSource).not.toContain('iCIMS Careers Portal')
  })

  /**
   * The guard on the whole mechanism. Every board before iCIMS puts the posting
   * in the top document, and a frame that got to answer first could displace a
   * good read with a worse one — an embedded video, a related-jobs widget.
   */
  it('leaves the page alone when the page has something to say', async () => {
    writePage('<h1>the real posting</h1>')
    givePageATitle('Principal Engineer')
    frameWith('<h1>a widget</h1>')

    capture(location.href, { reportEmpty: true })
    await settle()

    expect(reportFrom(0).fields).toMatchObject({ jobTitle: 'Principal Engineer' })
  })

  /**
   * A diagnostic pulled on the iCIMS shell reported `coverage 0.00` and six
   * fields `not found`, which was true of the document it read and false about
   * the page. Where nothing is worth offering, the best read is the honest one
   * to describe — the shell has strictly less to say than the frame does.
   */
  it('describes the frame in a diagnostic, not the shell around it', async () => {
    writePage('<p>iCIMS Careers Portal</p>')
    const inner = frameWith('<h1>a posting with no title tag</h1>')
    // A location and nothing else: enough for the frame to have said something,
    // not enough for `isWorthOffering`, which wants a company or a title.
    inner.head.innerHTML =
      '<meta name="twitter:label1" content="Location" />' +
      '<meta name="twitter:data1" content="Remote, US" />'

    capture(location.href, { reportEmpty: true })
    await settle()

    expect(kinds()).toEqual(['diagnostic/report'])
    expect(reportFrom(0).confidence).toBeGreaterThan(0)
  })
})
