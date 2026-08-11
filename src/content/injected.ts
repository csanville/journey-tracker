import { capture } from './capture'

/**
 * The one-shot reader, put onto a tab by an explicit user gesture.
 *
 * This is the long tail: a company's own careers page, a board nobody has
 * written an adapter for, a Greenhouse embed rendering into a host domain the
 * manifest has no business matching. `activeTab` grants access to exactly one
 * tab, at the moment the user asks, and it lapses on navigation — which is the
 * whole trade decision 2 makes. Automatic detection on those sites is what is
 * given up; a deliberate gesture is the price of not asking for every site.
 *
 * **Built as its own self-contained bundle**, and that is not incidental. The
 * declared content script is compiled to a loader that `import()`s the real
 * module, and a dynamic import is only allowed from an origin listed in
 * `web_accessible_resources` — which lists the three boards the manifest
 * matches. Injecting that loader into an unknown site would fail at the import,
 * on exactly the sites this exists to reach, and would fail quietly in the
 * page's console where nobody is looking. A single IIFE with no imports at
 * runtime has nothing to fetch and nothing to be refused.
 *
 * No `watchUrl` here. The grant covers this page, now; following the tab as it
 * navigates is neither permitted nor wanted from a guest.
 *
 * `reportEmpty` is what makes this the diagnostic path and the declared script
 * not. The user asked for *this page* by name, so a read that comes back with
 * nothing owes them a reason rather than silence — and the same gesture that
 * makes the read permitted makes the reason consented to. See `capture.ts`.
 */

capture(location.href, { reportEmpty: true })
