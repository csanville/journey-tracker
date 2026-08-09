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
 * The pending-submission queue changed. Go and read it.
 *
 * **Carries no posting id, deliberately.** It used to, and the panel rendered
 * the prompt straight from the payload — which worked only while the panel was
 * open to receive it, and phase 10 wrote the questions down precisely because
 * that is the uncommon case. Once they are in a store, an id in the event is a
 * second copy of a fact already recorded, and the panel would have two routes to
 * the same prompt: the payload when it happens to be open, the store when it is
 * not. Two routes that must agree is the shape this project keeps paying for.
 *
 * So this is a signal, exactly like `detection/changed` above: it says something
 * moved, and the panel re-reads the one place the answer lives. Decision 16's
 * "refresh everything" still does not apply — the panel refreshes the queue, not
 * the active tab's detection, which would neither ask this question nor answer
 * it.
 */
export interface SubmissionsPending {
  type: 'submission/pending'
  tabId: number
}

export type ExtensionEvent = DetectionChanged | SubmissionsPending

export function isEvent(value: unknown): value is ExtensionEvent {
  if (typeof value !== 'object' || value === null) return false

  const event = value as { type?: unknown; tabId?: unknown }
  if (typeof event.tabId !== 'number') return false

  return event.type === 'detection/changed' || event.type === 'submission/pending'
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
