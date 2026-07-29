import { send } from '../lib/client'
import { extract, isWorthOffering } from '../lib/extract'
import { buildSnapshot } from '../lib/extract/snapshot'
import { newId } from '../lib/ids'
import { watchUrl } from './watch-url'

/**
 * The reader on the page.
 *
 * It parses, and it reports its own `location.href` — the extension never asks
 * Chrome what a tab's URL is, which is what keeps the `tabs` permission out of
 * the manifest (decision 2). It writes nothing: content scripts cannot reach the
 * extension's IndexedDB at all, and the worker is the single writer regardless
 * (decision 4).
 *
 * Only the top frame runs this. Job boards embedded into a company's own careers
 * page are therefore not covered here — the modern Greenhouse and Ashby embeds
 * render into the host page's DOM on a domain this extension has no business
 * matching, and reaching them is what phase 5's click-initiated `activeTab`
 * capture is for.
 */

/**
 * When to try after a navigation.
 *
 * A single-page board changes the URL first and renders the new posting some
 * unknown number of milliseconds later, so the first read routinely lands on the
 * *previous* posting's markup or on a skeleton. The ladder retries until a read
 * produces something worth offering, then stops. Three attempts over two and a
 * half seconds covers what these boards actually do without leaving a timer
 * running on every job page indefinitely.
 */
const ATTEMPT_DELAYS_MS = [250, 900, 2500]

/** Cancels the in-flight ladder when a newer navigation supersedes it. */
let generation = 0

async function report(url: string): Promise<boolean> {
  const extraction = extract(document, url)
  if (!isWorthOffering(extraction)) return false

  const { trimmedSource, truncated } = buildSnapshot(document)

  await send('detection/report', {
    report: {
      detectionId: newId(),
      url,
      ...extraction,
      snapshot: { trimmedSource, truncated },
    },
  })

  return true
}

function capture(url: string): void {
  const mine = ++generation
  let settled = false
  let inFlight = false

  for (const delay of ATTEMPT_DELAYS_MS) {
    setTimeout(() => {
      // `settled` — an earlier rung already got an answer; the rest exist for
      // slow renders, not to re-report a page that has answered.
      // `inFlight` — the worker was cold and an earlier rung is still waiting
      // on it, so this one would race its own predecessor.
      // `mine !== generation` or a moved `location.href` — a newer navigation
      // superseded this ladder, and its answer would be about the wrong page.
      if (settled || inFlight || mine !== generation || location.href !== url) return

      inFlight = true
      void report(url)
        .then((offered) => {
          settled = offered
        })
        .catch((error: unknown) => {
          // A torn-down worker is ordinary and `send` already retries through
          // it; anything left is worth a line in the page console and nothing
          // more. The extension must never break a job board.
          console.debug('[JourneyTracker] could not report this page', error)
        })
        .finally(() => {
          inFlight = false
        })
    }, delay)
  }
}

capture(location.href)

watchUrl((url) => capture(url))
