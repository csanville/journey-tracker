import { send } from '../lib/client'
import type { CachedFailedParse, DetectionSummary } from '../lib/detection'

/**
 * Asking the worker what is on the tab this panel is sitting next to.
 *
 * `chrome.tabs.query` needs no permission for what is wanted here. The `tabs`
 * permission gates a tab's `url`, `title` and `favIconUrl`; `id` is returned to
 * anyone. So the panel can learn *which* tab it is looking at without being able
 * to learn *where* that tab is — which is exactly the line decision 2 draws. The
 * URL still arrives only because a content script on an allowlisted host chose
 * to report its own.
 *
 * `currentWindow` resolves to the window containing the side panel, which is the
 * window whose tab the user is looking at.
 */
export async function activeTabDetection(): Promise<DetectionSummary | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) return null

  return send('detection/get', { tabId: tab.id })
}

/**
 * Why the tab this panel sits beside gave up nothing, or `null` if it never
 * said.
 *
 * Asked only when `activeTabDetection` came back empty, which is not merely an
 * optimisation: a failed parse and a detection can both be held for one tab —
 * a board that renders late fails one read and succeeds the next — and the
 * detection is the better answer whenever there is one. Not asking is how that
 * preference is expressed, rather than asking and then discarding.
 */
export async function activeTabDiagnostic(): Promise<CachedFailedParse | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) return null

  return send('diagnostic/get', { tabId: tab.id })
}
