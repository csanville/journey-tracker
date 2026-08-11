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
 * **Which of the two page states wins, and why it is not "whichever is newer".**
 * A tab can hold both a detection and a failed parse: a board that renders late
 * fails a read and succeeds the next one, and only navigation clears them
 * together. The detection wins unconditionally, because the two are not rival
 * observations of the same event — a detection means the page *was* read, and a
 * failed parse means an earlier attempt was not. Reporting the failure while a
 * detection sits next to it would describe the extension as broken on a page it
 * had already parsed.
 */

import type { CachedFailedParse, DetectionSummary } from '../lib/detection'
import { buildReport, type DiagnosticsReport, type PageParse } from '../lib/diagnostics'
import type { StatusReport } from '../lib/messages'

export interface ReportInput {
  status: StatusReport
  /** What the active tab reported, or `null` if it never did. */
  detection: DetectionSummary | null
  /** Why the active tab reported nothing, or `null` if it never said. */
  diagnostic: CachedFailedParse | null
  extensionVersion: string
  at: number
}

/**
 * Picks the page state to describe.
 *
 * Both `DetectionSummary` and `CachedFailedParse` satisfy `ParsedPage`
 * structurally, and neither can carry a field value into it — `ParsedPage` has
 * no `fields`, so the choice here cannot become a leak whichever way it goes.
 */
function pageParse(input: ReportInput): PageParse {
  if (input.detection) return { read: true, parse: input.detection }
  if (input.diagnostic) return { read: true, parse: input.diagnostic }

  return { read: false, reason: 'not-read' }
}

/**
 * The URL the report describes, or `null` when the extension has none.
 *
 * Never `chrome.tabs`. The panel can learn *which* tab it sits beside without
 * the `tabs` permission but not *where* it is (decision 2), so the only URLs
 * that ever reach here are the ones a content script reported about its own
 * page. A tab nobody has read has no URL to report, and saying so is the honest
 * answer rather than a gap.
 */
function reportedUrl(input: ReportInput): string | null {
  return input.detection?.url ?? input.diagnostic?.url ?? null
}

export function panelReport(input: ReportInput): DiagnosticsReport {
  return buildReport({
    at: input.at,
    extensionVersion: input.extensionVersion,
    url: reportedUrl(input),
    status: input.status,
    parse: pageParse(input),
  })
}
