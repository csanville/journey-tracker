/**
 * URL canonicalization — the primary dedupe key (decision 7).
 *
 * The same posting is reachable through many URLs: a LinkedIn click, a
 * newsletter link, a recruiter's tracked share, the board's own listing. All of
 * them should collapse to one record.
 *
 * The danger runs the other direction, though, and it is the reason this is a
 * blocklist rather than an allowlist. Every query parameter stripped is a bet
 * that it does not identify the posting. `gh_src` is a Greenhouse traffic
 * source and safe to drop; `gh_jid` one character away is the job id, and
 * dropping it would collapse every posting on a board into a single record. So
 * nothing is removed unless it is named here, and unrecognised parameters are
 * kept even though that leaves some duplicates uncollapsed. A visible duplicate
 * is recoverable; a silent merge is not.
 */

/** Parameters that describe how someone arrived, never which posting it is. */
const TRACKING_PARAMS = new Set([
  // Ad-network click ids.
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'twclid',
  'yclid',
  'igshid',
  'ttclid',
  // Email and marketing platforms.
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_enc_id',
  'oly_anon_id',
  // Generic referral breadcrumbs.
  'ref',
  'referer',
  'referrer',
  'source',
  'src',
  'trk',
  'trkcampaign',
  'origin',
  'campaign',
  // ATS-specific traffic sources. Note what is *not* here: gh_jid, ashby_jid,
  // jk and vjk all identify the posting itself.
  'gh_src',
  'lever-source',
  'lever-origin',
  'ashby_source',
  // LinkedIn's per-impression noise.
  'refid',
  'trackingid',
  'lipi',
  'licu',
  'position',
  'pagenum',
  'ebp',
  'originalsubdomain',
])

/** Whole families of tracking parameters, matched on prefix. */
const TRACKING_PREFIXES = ['utm_', 'hsa_', 'pk_', 'mtm_', 'matomo_', 'piwik_']

function isTracking(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))
  )
}

/**
 * Whether a fragment carries routing rather than scroll position.
 *
 * Single-page job boards put the posting in the fragment (`#/job/4012345`), so
 * dropping every fragment would merge distinct postings — the exact failure this
 * module is built to avoid. `#apply` or `#content` is a scroll target and only
 * adds noise. The split: a path-shaped fragment, or one carrying an id-shaped
 * run of digits, is kept.
 */
function fragmentIsMeaningful(fragment: string): boolean {
  return fragment.includes('/') || /\d{4,}/.test(fragment)
}

/**
 * Reduces a URL to a stable identity for the posting it points at.
 *
 * Returns the trimmed input unchanged when it cannot be parsed — a record with
 * an odd URL is still worth keeping, and an unparseable string is at least
 * consistent with itself.
 */
export function canonicalizeUrl(raw: string): string {
  const trimmed = raw.trim()

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }

  // http and https reach the same posting; pick one so they agree. Other
  // schemes are left alone rather than guessed at.
  if (url.protocol === 'http:') url.protocol = 'https:'

  // `www.` is presentational. Deeper subdomains are not — `acme.greenhouse.io`
  // and `boards.greenhouse.io` are different boards.
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')

  // The URL parser already drops the port when it matches the scheme default.
  // An explicit non-default port is part of the address and stays.

  // Case is significant in a path, so only the trailing slash is touched.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1)
  }

  for (const name of [...url.searchParams.keys()]) {
    if (isTracking(name)) url.searchParams.delete(name)
  }

  // Two links differing only in parameter order are one posting.
  url.searchParams.sort()

  url.hash = fragmentIsMeaningful(url.hash.replace(/^#/, '')) ? url.hash : ''

  // `toString()` re-adds a trailing slash to an empty path; that is the correct
  // canonical form for a bare origin, so leave it.
  return url.toString()
}
