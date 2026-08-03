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

capture(location.href)

watchUrl((url) => capture(url))
