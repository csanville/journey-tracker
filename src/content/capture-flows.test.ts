// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://premera.wd5.myworkdayjobs.com/en-US/Premera/job/Mountlake-Terrace-WA/Software-Development-Engineer-III--React-and-React-Native_R28643-1" }
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The refusal to read an application flow, driven through `capture`.
 *
 * A separate file from `capture.test.ts` because the origin is the point.
 * jsdom's URL is fixed per file, `capture` cancels its own ladder when
 * `location.href` has moved on from the URL it was asked about, and the two
 * together are a trap: called with a Workday URL from a page that is *not*
 * Workday, this would report nothing whether the guard existed or not, and the
 * test would pass for a reason that has nothing to do with what it claims. So
 * the document really is the posting, and the flow is reached by moving within
 * it, exactly as Workday does.
 */
const send = vi.fn(async (_kind: string, _payload: unknown) => ({}) as never)

vi.mock('../lib/client', () => ({ send }))

const { capture } = await import('./capture')

const POSTING_PATH =
  '/en-US/Premera/job/Mountlake-Terrace-WA/Software-Development-Engineer-III--React-and-React-Native_R28643-1'
const APPLY_PATH = `${POSTING_PATH}/apply/autofillWithResume?source=LinkedIn`

/**
 * A page the adapters will happily read, so that a silent result is the guard
 * and never the parse.
 *
 * This is what makes the flow case meaningful: the Workday application document
 * inherits the posting's head on a same-document navigation, so the JSON-LD and
 * the meta tags are still there and `isWorthOffering` still passes. The page
 * being unreadable is not what stops it being read.
 */
function writeReadablePage(path: string): void {
  document.head.innerHTML = `<meta property="og:title" content="Software Development Engineer III" />`
  document.body.innerHTML = '<main><p>About the role</p></main>'
  history.replaceState(null, '', path)
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) {
    await vi.advanceTimersByTimeAsync(3000)
  }
}

beforeEach(() => {
  send.mockClear()
  send.mockResolvedValue({} as never)
  vi.useFakeTimers()
})

describe('the resident script and an application flow', () => {
  it('reads the posting, which is the control', async () => {
    // Without this the assertions below could all pass on a page that was never
    // readable in the first place.
    writeReadablePage(POSTING_PATH)

    capture(location.href)
    await settle()

    expect(send.mock.calls.map(([kind]) => kind)).toEqual(['detection/report'])
  })

  it('refuses the application the posting leads to', async () => {
    writeReadablePage(APPLY_PATH)

    capture(location.href)
    await settle()

    // Nothing parsed, nothing snapshotted, nothing sent. The document is not
    // read at all, which is the claim — a filter on the way out would still have
    // built a snapshot of the page first.
    expect(send).not.toHaveBeenCalled()
  })

  it('still refuses when the flow is reached without a page load', async () => {
    // The route `exclude_matches` cannot see, and the reason this guard exists.
    // The script is already running on the posting; Workday changes the URL
    // underneath it and `watch-url.ts` calls `capture` again.
    writeReadablePage(POSTING_PATH)
    capture(location.href)
    await settle()
    send.mockClear()

    history.replaceState(null, '', APPLY_PATH)
    capture(location.href)
    await settle()

    expect(send).not.toHaveBeenCalled()
  })

  it('reads it anyway when the user asked for this page by name', async () => {
    // The injected bundle's case. The gesture is the consent, and phase 11 made
    // this argument for the diagnostic already: refusing here would be
    // second-guessing an explicit request about a page the user is looking at.
    writeReadablePage(APPLY_PATH)

    capture(location.href, { readApplicationFlows: true })
    await settle()

    expect(send.mock.calls.map(([kind]) => kind)).toEqual(['detection/report'])
  })
})
