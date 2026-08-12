/**
 * Telling a posting apart from an application being filled in.
 *
 * Phase 12 put a wildcard in the manifest for the first time —
 * `https://*.myworkdayjobs.com/*`, because on Workday the tenant *is* the
 * subdomain and no allowlist can enumerate employers. What that wildcard covers,
 * besides every tenant's postings, is every tenant's **application flow**: the
 * seven steps of a Workday application, including the page where the user types
 * their address and the voluntary self-identification questionnaire. That is the
 * category of data decision 6's trimming amendment exists for, and decision 2's
 * whole position is that the extension should not be able to read it rather than
 * that it should be trusted not to keep it.
 *
 * **The manifest alone cannot deliver that.** `exclude_matches` is evaluated
 * when a content script is *injected*, and the ordinary route into an
 * application is a same-document navigation from the posting page — the script
 * is already running, and nothing re-evaluates the patterns. `watch-url.ts`
 * exists precisely to follow those navigations, so the resident script would
 * notice the flow and read it. The exclusions still close a cold load straight
 * into an apply URL, which a link from a job aggregator produces, so both are
 * built; neither is sufficient.
 *
 * This module is the runtime half, and the source of truth the manifest's
 * `exclude_matches` are checked against — see `manifest.test.ts`, which asserts
 * the two agree about a real URL rather than trusting that somebody kept them in
 * step.
 *
 * ## What is matched, and what is deliberately not
 *
 * Only `/apply/` as a path segment, because that is what a real Workday
 * application was observed to use:
 *
 *     …/job/Mountlake-Terrace-WA/Software-…-Native_R28643-1/apply/autofillWithResume
 *
 * and the URL does **not** change as the user moves between steps — `My
 * Information` and `Application Questions` are the same address. One pattern
 * therefore covers the whole flow, and one refusal covers every step.
 *
 * Nothing is matched speculatively. Phase 11 wrote an enum by imagining the
 * failures and lost two of its three values to reality; a pattern list invented
 * the same way would either miss the shapes that exist or exclude postings that
 * do not deserve it, and the second failure is silent. When another flow shape
 * is *observed*, it is added here and the manifest follows.
 */

/**
 * Host-scoped, exactly as the manifest's `exclude_matches` are.
 *
 * The scoping is the load-bearing part and it is a decision, not an accident of
 * expression. A bare `/apply/` rule would also refuse **Lever's** apply form,
 * which is `/<company>/<id>/apply` — a board that has been read since phase 5,
 * that this phase's wildcard has nothing to do with, and whose behaviour would
 * have changed silently. The same privacy argument does apply there, and the
 * same cost comes with it: a refused read means the panel forgets the posting
 * while the user is applying to it. That is a trade worth making deliberately
 * for a board, not as a side effect of a regex written for a different one.
 *
 * The path is `/apply` as a whole segment, anchored on the separators so that a
 * posting whose title contains the word — `Apply-Analytics-Engineer_R28643-1` —
 * is not swept up. The trailing alternation covers a bare `…/apply`, which the
 * observed URLs always extend but which nothing guarantees they must.
 */
const EXCLUSIONS: ReadonlyArray<{ host: RegExp; path: RegExp }> = [
  { host: /(^|\.)myworkdayjobs\.com$/, path: /\/apply(\/|$)/ },
]

/**
 * Whether this URL is somebody filling in an application rather than reading a
 * posting.
 *
 * Answers `false` for anything unparseable, which is the safe direction here:
 * the caller uses this to *refuse* a read, and a URL this cannot understand is
 * not evidence of an application flow. The reads it guards are already confined
 * to hosts the manifest names.
 */
export function isApplicationFlow(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  return EXCLUSIONS.some(
    (rule) => rule.host.test(url.hostname) && rule.path.test(url.pathname),
  )
}
