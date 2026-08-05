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

/**
 * A tracked posting was just applied to, as far as the confirmation page says.
 *
 * Carries the record's id rather than the record, so the panel reads the
 * current one instead of rendering a copy that was already stale when it was
 * put in the message.
 *
 * This is the second member of the union, which decision 16 said would be the
 * moment "refresh everything" stopped being the right answer for the panel —
 * and it is: this event asks a question about one record, and refreshing the
 * active tab's detection would neither ask it nor answer it.
 */
export interface ApplicationSubmitted {
  type: 'application/submitted'
  tabId: number
  postingId: string
}

export type ExtensionEvent = DetectionChanged | ApplicationSubmitted

export function isEvent(value: unknown): value is ExtensionEvent {
  if (typeof value !== 'object' || value === null) return false

  const event = value as { type?: unknown; tabId?: unknown; postingId?: unknown }
  if (typeof event.tabId !== 'number') return false

  if (event.type === 'detection/changed') return true

  return event.type === 'application/submitted' && typeof event.postingId === 'string'
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
