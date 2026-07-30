/**
 * The worker's one-way channel to the panel.
 *
 * Phase 4's panel only learned about a page when it was mounted or refocused,
 * which was enough while filling was a button. Phase 5 has the form follow the
 * active tab, and a content script that finishes parsing *while* the panel is
 * open has no way to say so through the request protocol — that one runs
 * panel-to-worker, and nothing in it lets the worker speak first.
 *
 * Discriminated on `type` rather than `kind` on purpose. The worker's own
 * `onMessage` listener treats anything carrying a `kind` as a request and hands
 * it to the dispatcher, which throws on an unknown one. Using a different key
 * means an event can never be mistaken for a request, in either direction, even
 * though `chrome.runtime.sendMessage` does not deliver to the sender's own
 * context today. That is a runtime detail; this is a type.
 */

/** A tab's detection changed — reported, re-reported, or gone. */
export interface DetectionChanged {
  type: 'detection/changed'
  tabId: number
}

export type ExtensionEvent = DetectionChanged

export function isEvent(value: unknown): value is ExtensionEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'detection/changed' &&
    typeof (value as { tabId?: unknown }).tabId === 'number'
  )
}

/**
 * Announces an event to whatever extension contexts are listening.
 *
 * Rejection is the ordinary case, not the exceptional one: with the panel
 * closed there is no receiver, and `sendMessage` rejects with "Could not
 * establish connection. Receiving end does not exist." Most of the time nobody
 * is looking at the panel, so letting that propagate would fill the worker's
 * console with a failure that means "working as intended" and would abort the
 * detection path that called it.
 */
export async function broadcast(event: ExtensionEvent): Promise<void> {
  try {
    await chrome.runtime.sendMessage(event)
  } catch {
    // Nobody listening. See above.
  }
}
