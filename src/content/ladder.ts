/**
 * Retrying a read until the page has finished becoming itself.
 *
 * A single-page board changes the URL first and renders the new posting some
 * unknown number of milliseconds later, so the first read routinely lands on the
 * previous posting's markup or on a skeleton. The ladder retries until a read
 * produces something worth offering, then stops.
 *
 * Split out of `content-script.ts` and given injected timers so its scheduling
 * can be tested. The first version ran the rungs as independent `setTimeout`s
 * with an `inFlight` guard, and the guard ate them: on a cold worker the first
 * report is still in flight when the second rung fires, so that rung returned
 * having done nothing and was gone. Three attempts silently became two, in
 * exactly the case — a worker that needs waking — where the retries were most
 * needed. Running the rungs in sequence, each waiting for the last to finish,
 * makes the delays a floor on when an attempt starts rather than a fixed
 * timetable that a slow attempt can fall off.
 */

/** Time to wait before each attempt, measured from the end of the previous one. */
export const ATTEMPT_DELAYS_MS = [250, 900, 2500]

export interface LadderOptions {
  /** Resolves true when the page gave up something worth offering. */
  attempt: () => Promise<boolean>
  /** False when a newer navigation has superseded this run. */
  stillWanted: () => boolean
  delays?: readonly number[]
  wait?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs `attempt` on the delay ladder until it succeeds or the rungs run out.
 *
 * Resolves true if any attempt succeeded. A thrown attempt is treated as a
 * failed one and does not stop the ladder — a torn-down service worker is the
 * ordinary reason for it, and the next rung is exactly the right response.
 */
export async function runLadder(options: LadderOptions): Promise<boolean> {
  const { attempt, stillWanted } = options
  const delays = options.delays ?? ATTEMPT_DELAYS_MS
  const wait = options.wait ?? sleep

  for (const delay of delays) {
    await wait(delay)
    if (!stillWanted()) return false

    try {
      if (await attempt()) return true
    } catch {
      // Left to the caller to report. Swallowed here so one failed rung cannot
      // take the rest of the ladder with it.
    }

    if (!stillWanted()) return false
  }

  return false
}
