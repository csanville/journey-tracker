/**
 * Questions the extension is still waiting for an answer to.
 *
 * Phase 8 detected a Greenhouse submission and broadcast it. If the panel was
 * not already open the broadcast went nowhere — `broadcast` swallows the
 * rejection, which is correct for an event and fatal for a question — and
 * nothing was persisted or retried. Since almost nobody keeps a side panel open
 * while filling in an application form, the one submission signal that is not a
 * heuristic did nothing in its ordinary case.
 *
 * So the question is written down instead of shouted, and the shout demoted to
 * "go and look". That is what makes the panel-open and panel-closed paths the
 * same path rather than two that have to agree.
 *
 * **`local`, not `session`.** The detection cache next door is page-derived and
 * rightly dies with the browser. This is not: the realistic sequence is applying
 * to three jobs on a Friday evening and closing the laptop, and `session` throws
 * exactly that away. `local` is also the store a migration is not itself
 * rewriting (decision 9), which is why the settings live there too.
 *
 * Nothing here writes to a record. Decision 12 is that detection prompts rather
 * than writes, and persisting the prompt does not change what a prompt is — the
 * user still answers it, and a wrong match still costs one dismissal.
 */

import { createSerializer } from './serialize'

const PENDING_KEY = 'pendingSubmissions'

/**
 * How long an unanswered question is worth asking.
 *
 * The obvious argument for an expiry is that a late answer would misdate the
 * record, and that argument does not apply here: `confirmedAt` below is the
 * moment the *confirmation page* was seen, so the date on the record is right
 * however late the answer arrives. That was deliberate, and it is what lets this
 * number be chosen for a softer reason.
 *
 * What it is actually for: beyond a couple of weeks nobody can reliably say
 * whether they applied to a particular posting, and a question that invites a
 * guess is worse than no question — a guessed "yes" writes an application that
 * never happened into the funnel. Fourteen days covers a holiday and stops well
 * short of the point where the user is reconstructing rather than remembering.
 */
export const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * How many unanswered questions to keep.
 *
 * A bound rather than a limit anyone should reach: twenty unanswered
 * confirmations means the prompt is not working, not that somebody is busy.
 * It exists because this is `local` — nothing clears it for us on browser
 * close, unlike the detection cache — so an unnoticed loop would grow it
 * forever.
 *
 * The **newest** survive when it overflows, which is the opposite of the queue's
 * answering order and is deliberate. The oldest entry is the one closest to
 * expiring and the one the user is least able to answer accurately; if something
 * has to be dropped, dropping the question that was about to become unanswerable
 * costs less than dropping the one from ten minutes ago.
 */
export const MAX_PENDING = 20

/** A submission the user has not yet confirmed or dismissed. */
export interface PendingSubmission {
  postingId: string
  /**
   * When the worker saw the confirmation page — *not* when the user answers.
   *
   * This is the date that lands on the record, which is why it is captured on
   * the worker's side at detection time. Answering on Monday a prompt raised on
   * Friday has to record Friday: `appliedAt` is what the whole response funnel
   * measures from, and a prompt that can wait days would otherwise report every
   * application as having happened whenever the panel was next opened.
   */
  confirmedAt: number
}

/** Stored as id → `confirmedAt`. The value is the only field that varies. */
type Store = Record<string, number>

const serialized = createSerializer()

async function readStore(): Promise<Store> {
  const stored = await chrome.storage.local.get(PENDING_KEY)
  const store = stored[PENDING_KEY]

  if (typeof store !== 'object' || store === null) return {}

  // Anything that is not a timestamp is dropped rather than carried. This store
  // outlives a browser restart and therefore outlives the build that wrote it,
  // so a shape from a future or half-written version is reachable here in a way
  // it is not in `session`.
  return Object.fromEntries(
    Object.entries(store as Record<string, unknown>).filter(
      ([, confirmedAt]) => typeof confirmedAt === 'number' && Number.isFinite(confirmedAt),
    ),
  ) as Store
}

async function writeStore(store: Store): Promise<void> {
  await chrome.storage.local.set({ [PENDING_KEY]: store })
}

/** Drops expired entries, and says whether it dropped any. */
function sweep(store: Store, now: number): boolean {
  let dropped = false

  for (const [postingId, confirmedAt] of Object.entries(store)) {
    if (now - confirmedAt < PENDING_TTL_MS) continue
    delete store[postingId]
    dropped = true
  }

  return dropped
}

/**
 * Records that a confirmation page was seen for a posting.
 *
 * The **earliest** `confirmedAt` wins when the same posting is confirmed twice,
 * because the first sighting is the real one — reloading a confirmation page, or
 * coming back to it from history, is not a second application and must not
 * re-date the first.
 */
export function recordPending(
  postingId: string,
  confirmedAt: number = Date.now(),
): Promise<void> {
  return serialized(async () => {
    const store = await readStore()

    sweep(store, confirmedAt)

    const existing = store[postingId]
    store[postingId] =
      existing === undefined ? confirmedAt : Math.min(existing, confirmedAt)

    const entries = Object.entries(store)
    if (entries.length > MAX_PENDING) {
      const survivors = entries.sort(([, a], [, b]) => b - a).slice(0, MAX_PENDING)
      await writeStore(Object.fromEntries(survivors))
      return
    }

    await writeStore(store)
  })
}

/**
 * Every unanswered question, oldest first — which is the order they are asked
 * in, so the queue drains in the order the applications actually happened.
 *
 * Writes back when it finds expired entries, which makes a read occasionally a
 * write. The alternative is a store that only ever grows: nothing else runs
 * often enough to sweep it, and `local` is not cleared for us. Serialized like
 * every other access, so the write is safe from here.
 */
export function readPending(now: number = Date.now()): Promise<PendingSubmission[]> {
  return serialized(async () => {
    const store = await readStore()

    if (sweep(store, now)) await writeStore(store)

    return Object.entries(store)
      .map(([postingId, confirmedAt]) => ({ postingId, confirmedAt }))
      .sort((a, b) => a.confirmedAt - b.confirmedAt)
  })
}

/**
 * Answers a question for good, and says whether there was one to answer.
 *
 * Both buttons land here. Dismissal is as durable as confirmation on purpose:
 * decision 13's amendment wants an answered question to stay answered, and
 * before this store the only place to record a dismissal was a ref that died
 * with the panel — so "no" lasted until the panel was closed and the prompt came
 * back on the next confirmation-page load.
 *
 * Not called when the user merely opens the record for editing. That skips the
 * question, it does not answer it — see `App`.
 */
export function retirePending(postingId: string): Promise<boolean> {
  return serialized(async () => {
    const store = await readStore()
    if (!(postingId in store)) return false

    delete store[postingId]
    await writeStore(store)
    return true
  })
}
