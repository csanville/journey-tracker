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
 * gesture and reads it once. Both parse identically, and they report a *success*
 * identically — the worker cannot tell those apart and nothing downstream
 * should care.
 *
 * They differ on failure, and `reportEmpty` is the whole of it. See below.
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

/**
 * Says why the page gave up nothing, once the ladder has stopped trying.
 *
 * Deliberately not sent per rung. A board that renders late fails the first read
 * and succeeds the third, and a diagnostic sent at the first would report
 * "nothing found" about a page that was merely slow — which is worse than
 * silence, because it is a confident wrong answer to the one question this
 * feature exists to answer honestly.
 *
 * The extraction is re-run rather than carried out of `report`. It is a pure
 * read of the current DOM and the page has had the whole ladder to finish
 * arriving, so re-reading describes the page as it finally is rather than as it
 * was on the rung that happened to fail. No snapshot goes with it: this is the
 * input to something the user may send onward.
 */
async function reportEmptyParse(url: string): Promise<void> {
  const { fields: _fields, ...rest } = extract(document, url)

  await send('diagnostic/report', { report: { url, ...rest } })
}

export interface CaptureOptions {
  /**
   * Report a read that found nothing, instead of going quiet.
   *
   * False for the declared content script, and that is not timidity. It runs on
   * every page of three boards without being asked — search results, listing
   * pages, a company's board index — so reporting its blanks would accumulate a
   * record of ordinary browsing to answer a question nobody has asked, in an
   * extension whose whole claim is that it collects nothing.
   *
   * True for the injected bundle, where every one of those objections is
   * answered by the same fact: it is on the page because the user right-clicked
   * *this page* and asked. That gesture is the `activeTab` grant and the consent
   * at once, and the moment it produces nothing is exactly the moment somebody
   * wants to know why.
   */
  reportEmpty?: boolean
}

export function capture(url: string, options: CaptureOptions = {}): void {
  const mine = ++generation
  const stillWanted = () => mine === generation && location.href === url

  void runLadder({
    attempt: () => report(url),
    // Superseded by a newer navigation, or the page moved on underneath the
    // ladder. Either way the answer this would produce is about a URL that is
    // no longer the one being asked about.
    stillWanted,
  })
    .then(async (offered) => {
      // `runLadder` also resolves false when a newer navigation cancelled it, so
      // `stillWanted` is re-checked: a diagnostic about a page the tab has
      // already left is the same stale claim the ladder was cancelled to avoid.
      if (offered || !options.reportEmpty || !stillWanted()) return

      await reportEmptyParse(url)
    })
    .catch((error: unknown) => {
      // `runLadder` swallows a failed rung so the ladder survives it; anything
      // reaching here is worth a line in the page console and nothing more. The
      // extension must never break a job board.
      console.debug('[JourneyTracker] could not report this page', error)
    })
}
