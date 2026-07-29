import { send } from '../lib/client'
import { extract, isWorthOffering } from '../lib/extract'
import { buildSnapshot } from '../lib/extract/snapshot'
import { newId } from '../lib/ids'
import { runLadder } from './ladder'
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

  void runLadder({
    attempt: () => report(url),
    // Superseded by a newer navigation, or the page moved on underneath the
    // ladder. Either way the answer this would produce is about a URL that is
    // no longer the one being asked about.
    stillWanted: () => mine === generation && location.href === url,
  }).catch((error: unknown) => {
    // `runLadder` swallows a failed rung so the ladder survives it; anything
    // reaching here is worth a line in the page console and nothing more. The
    // extension must never break a job board.
    console.debug('[JourneyTracker] could not report this page', error)
  })
}

capture(location.href)

watchUrl((url) => capture(url))
