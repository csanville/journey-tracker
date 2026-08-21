import { send } from '../lib/client'
import { extract, isWorthOffering } from '../lib/extract'
import type { Extraction } from '../lib/extract'
import { isApplicationFlow } from '../lib/flows'
import { buildSnapshot } from '../lib/extract/snapshot'
import { newId } from '../lib/ids'
import { readableDocuments } from './frames'
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

/**
 * What one read produced.
 *
 * Three outcomes rather than a boolean, because two of them are false and they
 * mean opposite things about the page. `nothing` is the adapters declining to
 * offer it; `undelivered` is the adapters succeeding and the *worker* being
 * unreachable, which is the ordinary state of a torn-down MV3 worker. Collapsing
 * them is what let a page that parsed perfectly be reported as a page that gave
 * up nothing.
 */
type Attempt = 'offered' | 'nothing' | 'undelivered'

/**
 * The read, and which document it came out of.
 *
 * The two are returned together because everything downstream has to agree
 * about the second one. A snapshot built from the top frame while the fields
 * came from a child would be a stored source that cannot reproduce the record
 * attached to it, which is the one thing decision 6 asks a snapshot to do; a
 * diagnostic reporting the top frame's empty parse on a page that read fine one
 * frame down would be a confident wrong answer to the question phase 11 exists
 * to answer honestly.
 */
interface Read {
  extraction: Extraction
  source: Document
}

/**
 * Reads the page, looking past the top frame only when it has nothing to say.
 *
 * The order is the guard. `readableDocuments` puts the document the user is
 * looking at first and this takes the first read worth offering, so on the four
 * boards that came before iCIMS the loop ends on its first pass and no frame is
 * ever parsed. A frame gets a turn only where the top frame has already
 * declined, which is exactly the iCIMS shell and not much else.
 *
 * When nothing is worth offering, the *best-scoring* read is returned rather
 * than the top frame's. That only matters for the diagnostic, and it matters
 * there: a partial read from the frame that holds the posting describes the
 * page far better than a confident nothing from the shell around it.
 */
function readPage(url: string): Read {
  let best: Read | null = null

  for (const source of readableDocuments(document)) {
    const extraction = extract(source, url)
    if (isWorthOffering(extraction)) return { extraction, source }

    if (!best || extraction.confidence > best.extraction.confidence) {
      best = { extraction, source }
    }
  }

  // `readableDocuments` always returns the root, so the loop always ran.
  return best as Read
}

async function report(url: string): Promise<Attempt> {
  const { extraction, source } = readPage(url)
  if (!isWorthOffering(extraction)) return 'nothing'

  const { trimmedSource, truncated } = buildSnapshot(source)

  try {
    await send('detection/report', {
      report: {
        detectionId: newId(),
        url,
        ...extraction,
        snapshot: { trimmedSource, truncated },
      },
    })
  } catch (error) {
    // Caught here rather than thrown into the ladder, which swallows a throw
    // and would leave the caller unable to tell this apart from `nothing`. The
    // ladder still retries: the rung reports a failure either way.
    console.debug('[JourneyTracker] could not deliver this page', error)
    return 'undelivered'
  }

  return 'offered'
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
 *
 * Re-running means `readPage`, not `extract`, so the frame choice is made again
 * on the same terms. A frame that arrived late is the ordinary reason a rung
 * failed and the diagnostic should not still be describing the shell around it.
 */
async function reportEmptyParse(url: string): Promise<void> {
  const { fields: _fields, ...rest } = readPage(url).extraction

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
  /**
   * Read a page even when it is an application being filled in.
   *
   * The same split as `reportEmpty`, for the same reason, and it lands on the
   * same two callers.
   *
   * False for the declared content script. Phase 12's wildcard put it on every
   * Workday tenant, which means every Workday *application* as well, and
   * `exclude_matches` cannot keep it out of one: the route into an application
   * is a same-document navigation from the posting, so the script is already
   * running and nothing re-evaluates the manifest. `watch-url.ts` then notices
   * the new URL and this function is called for it. The exclusions close a cold
   * load into an apply URL; this closes the route the exclusions cannot see.
   *
   * True for the injected bundle. The user right-clicked *this page* and asked
   * for it to be read, which is consent for this page in a way that a manifest
   * pattern is not — and phase 11 already made this argument for the diagnostic.
   * Refusing here would be second-guessing an explicit request.
   */
  readApplicationFlows?: boolean
}

export function capture(url: string, options: CaptureOptions = {}): void {
  // Bumped before the refusal, not after. Arriving at an application flow is a
  // navigation like any other, and it has to cancel the ladder still running for
  // the posting behind it — otherwise a rung fires a moment later, `stillWanted`
  // compares against a URL this call never adopted, and the page being read is
  // the one this exists to refuse.
  const mine = ++generation
  const stillWanted = () => mine === generation && location.href === url

  // Before the parse, before the snapshot, before anything is sent. The whole
  // point is that the document is never read, so this cannot be a filter on the
  // way out.
  if (!options.readApplicationFlows && isApplicationFlow(url)) return

  /**
   * Whether any rung found the page worth offering, delivered or not.
   *
   * This, and not the ladder's own answer, is what decides whether a diagnostic
   * is honest. `runLadder` resolves false for three different reasons — nothing
   * found, nothing delivered, cancelled — and only the first is a page that gave
   * up nothing. A rung that parsed the page and could not reach the worker has
   * proved the opposite of what a diagnostic would claim.
   */
  let parsed = false

  void runLadder({
    attempt: async () => {
      const outcome = await report(url)
      if (outcome !== 'nothing') parsed = true

      return outcome === 'offered'
    },
    // Superseded by a newer navigation, or the page moved on underneath the
    // ladder. Either way the answer this would produce is about a URL that is
    // no longer the one being asked about.
    stillWanted,
  })
    .then(async () => {
      // `stillWanted` is re-checked because the ladder also resolves false when
      // a newer navigation cancelled it: a diagnostic about a page the tab has
      // already left is the same stale claim the cancellation exists to avoid.
      if (parsed || !options.reportEmpty || !stillWanted()) return

      await reportEmptyParse(url)
    })
    .catch((error: unknown) => {
      // `runLadder` swallows a failed rung so the ladder survives it; anything
      // reaching here is worth a line in the page console and nothing more. The
      // extension must never break a job board.
      console.debug('[JourneyTracker] could not report this page', error)
    })
}
