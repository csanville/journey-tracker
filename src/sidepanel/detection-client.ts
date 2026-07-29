import { send } from '../lib/client'
import type { DetectionSummary } from '../lib/detection'

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
