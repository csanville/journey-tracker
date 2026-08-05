/**
 * Noticing that an application actually went in.
 *
 * The roadmap's phase 8 was "submission heuristics behind a prompt", and the
 * premise did not survive decision 2. Detection needs code running on the page
 * at the moment of submission, and this extension has exactly two ways to get
 * code onto a page: the content script the manifest declares, and an
 * `activeTab` injection granted by a gesture. `activeTab` is revoked on
 * navigation — which is what a submission usually is — so everywhere outside
 * the declared hosts is not *hard* to detect, it is structurally undetectable
 * without `<all_urls>`. That is a permissions boundary, not a heuristic-quality
 * problem, and no amount of cleverness here moves it.
 *
 * What survives is one board and no heuristic at all. A submitted Greenhouse
 * application lands on
 *
 *     https://job-boards.greenhouse.io/<token>/jobs/<id>/confirmation
 *
 * which is a real page load, publicly indexed, carrying the job id — so it
 * joins straight back to the record by URL. The resident content script's
 * `watchUrl` already sees every URL change. This file is a URL match and
 * nothing more.
 *
 * **Lever is deliberately absent.** Its apply form is a distinct URL
 * (`/<company>/<id>/apply`), which is an intent signal, but the page after a
 * successful submission is an employer-configurable "Application Success Page
 * URL" that can redirect to an arbitrary host. There is no stable signal to
 * match, *by design*, and guessing at one would be exactly the mechanism
 * decision 3 keeps warning about: recorded as working because its existence was
 * checked rather than its behaviour.
 *
 * What this cannot see, stated so nobody has to rediscover it:
 *
 * - Any board without a declared content script. That is most of them.
 * - A Greenhouse form embedded in a company's own careers page, which renders
 *   on a domain the manifest has no business matching (phase 4 already lists
 *   this under what it does not cover).
 * - An application submitted with the extension disabled or the tab restored.
 *
 * A miss costs the user the manual save they were already making. That is the
 * right direction for this to be wrong in, and it is why the signal is allowed
 * to be narrow.
 */

/** The Greenhouse board hosts the manifest declares a content script on. */
const GREENHOUSE_HOSTS = ['job-boards.greenhouse.io', 'boards.greenhouse.io']

/**
 * The posting URL a confirmation page is confirming, or `null`.
 *
 * Conservative by construction: it matches one exact path shape on two known
 * hosts and rejects everything else, because the cost of a false positive is a
 * prompt about a job the user did not apply to — the one thing decision 12 says
 * would corrode trust in a tracker.
 *
 * The query string is dropped rather than carried. The confirmation page's
 * parameters describe the confirmation, not the posting, and the caller
 * canonicalizes the result anyway.
 */
export function confirmationTarget(url: string): string | null {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:') return null

  const host = parsed.hostname.toLowerCase()
  if (!GREENHOUSE_HOSTS.includes(host)) return null

  // `<token>/jobs/<id>/confirmation`, and exactly that. A longer or shorter
  // path is some other page, and `filter(Boolean)` absorbs the trailing slash
  // rather than letting it change the length.
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 4) return null

  const [token, jobs, id, confirmation] = segments
  if (jobs !== 'jobs' || confirmation !== 'confirmation') return null

  // Greenhouse job ids are numeric. Requiring it keeps a board that happens to
  // have a posting literally named `confirmation` from matching.
  if (id === undefined || !/^\d+$/.test(id)) return null

  return `https://${host}/${token}/jobs/${id}`
}
