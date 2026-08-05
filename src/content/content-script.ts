import { send } from '../lib/client'
import { confirmationTarget } from '../lib/confirmation'
import { capture } from './capture'
import { watchUrl } from './watch-url'

/**
 * The reader on the boards the manifest names.
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
 * matching. Reaching those, and any board nobody has written an adapter for, is
 * what `injected.ts` and the capture gesture are for.
 *
 * The difference between the two is `watchUrl`. This script is a resident on a
 * board it was allowed onto, so it keeps up with single-page navigation for as
 * long as the tab lives there. The injected one is a guest invited to look at
 * one page once.
 */

/**
 * Reports a page that is an application confirmation.
 *
 * Filtered here so an ordinary navigation costs nothing — without the check
 * every URL change on a board would wake the service worker, and decision 9
 * rests on the worker being idle enough to be torn down. The worker re-derives
 * the posting from the URL rather than trusting anything computed on this side;
 * see `application/submitted` in `messages.ts`.
 *
 * Never allowed to fail the page. A job board that breaks because this
 * extension is installed is a worse outcome than a missed prompt, and a missed
 * prompt only costs the manual save the user was already making.
 */
function reportIfConfirmation(url: string): void {
  if (confirmationTarget(url) === null) return

  void send('application/submitted', { url }).catch((error: unknown) => {
    console.debug('[JourneyTracker] could not report a submission', error)
  })
}

function visit(url: string): void {
  capture(url)
  reportIfConfirmation(url)
}

visit(location.href)

watchUrl((url) => visit(url))
