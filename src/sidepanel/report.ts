/**
 * Assembling the diagnostics report from what the panel already has.
 *
 * The panel is the only context that holds all three pieces at once — the
 * worker's `StatusReport`, and whatever the active tab reported — so this is
 * where they meet. It stays a pure function in a `.ts` module rather than
 * living in `App.tsx` for the reason phase 7 gave: a component is the one place
 * in this project that nothing executes by accident, and every branch below is
 * a state somebody will actually be in.
 *
 * **Which of the two page states wins.** A tab can hold both a detection and a
 * failed parse, and the first version of this preferred the detection
 * unconditionally on the grounds that they are not rival observations — a
 * detection means the page *was* read, and reporting a failure beside one would
 * call the extension broken on a page it had already parsed.
 *
 * That is right only while the two describe the *same page*, and review found
 * the case where they do not. A matched board that navigates without a page load
 * — Ashby is one — never fires `onUpdated`, so `forgetTab` never runs: posting A
 * stays cached as a detection while the user clicks through to posting B, and a
 * right-click on B records a diagnostic for B beside it. Preferring the
 * detection then described A, with its adapter and its coverage and `offered
 * yes`, on the exact page the user was reporting as unreadable. The report
 * contradicted the complaint that produced it.
 *
 * So the URLs decide it, and the panel has both — every cached entry carries the
 * URL the content script reported about itself. When they agree the detection
 * still wins, for the original reason. When they disagree one of them is about a
 * page the tab has left, and the panel **cannot ask which**: reading the active
 * tab's URL needs the `tabs` permission decision 2 keeps out of the manifest. So
 * the newer of the two wins, which is not knowledge but is the best available
 * proxy for it, and it is right in the case that actually occurs — the stale one
 * is stale precisely because something more recent happened.
 */

import type { CachedFailedParse, DetectionSummary } from '../lib/detection'
import { buildReport, type DiagnosticsReport } from '../lib/diagnostics'
import type { StatusReport } from '../lib/messages'

export interface ReportInput {
  /** `null` when the worker did not answer — itself the most reportable state. */
  status: StatusReport | null
  /** What the active tab reported, or `null` if it never did. */
  detection: DetectionSummary | null
  /** Why the active tab reported nothing, or `null` if it never said. */
  diagnostic: CachedFailedParse | null
  extensionVersion: string
  at: number
}

/**
 * The one of the two that describes the page in front of the user.
 *
 * `null` when neither reported. See the note above for why the URLs decide it
 * and why `capturedAt` only breaks the tie.
 */
function describes(input: ReportInput): DetectionSummary | CachedFailedParse | null {
  const { detection, diagnostic } = input

  if (!detection) return diagnostic
  if (!diagnostic) return detection

  // Same page: the detection is strictly the better answer, since the page did
  // parse and a failure beside it is about an earlier attempt on it.
  if (detection.url === diagnostic.url) return detection

  // Different pages: one is about a page the tab has left, and the panel has no
  // way to ask which. Newest is the best proxy — the older is old *because*
  // something more recent happened on that tab.
  return diagnostic.capturedAt > detection.capturedAt ? diagnostic : detection
}

export function panelReport(input: ReportInput): DiagnosticsReport {
  const page = describes(input)

  return buildReport({
    at: input.at,
    extensionVersion: input.extensionVersion,
    /*
     * Never `chrome.tabs`. The panel can learn *which* tab it sits beside
     * without the `tabs` permission but not *where* it is (decision 2), so the
     * only URLs that reach here are the ones a content script reported about its
     * own page. A tab nobody has read has none, and saying so is the honest
     * answer rather than a gap.
     *
     * Taken from the same entry the parse comes from, which is what stops the
     * report naming one page and describing another.
     */
    url: page?.url ?? null,
    status: input.status,
    /*
     * Both `DetectionSummary` and `CachedFailedParse` satisfy `ParsedPage`
     * structurally, and neither can carry a field value into it — `ParsedPage`
     * has no `fields`, so this choice cannot become a leak whichever way it
     * goes.
     */
    parse: page ? { read: true, parse: page } : { read: false, reason: 'not-read' },
  })
}
