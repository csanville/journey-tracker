import { send } from '../lib/client'
import { extract, isWorthOffering } from '../lib/extract'
import { buildSnapshot } from '../lib/extract/snapshot'
import { newId } from '../lib/ids'
import { runLadder } from './ladder'

/**
 * Reading the page and reporting it, shared by both ways this code reaches a
 * page.
 *
 * The declared content script (`content-script.ts`) runs itself on the boards
 * the manifest matches and keeps watching for single-page navigation. The
 * injected bundle (`injected.ts`) is put onto one tab by an explicit user
 * gesture and reads it once. Both parse identically and report identically —
 * the worker cannot tell them apart, and nothing downstream should care.
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

export function capture(url: string): void {
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
