/**
 * Requisition ids read out of ATS URLs (decision 7).
 *
 * The req id is the one hard key in this data. Company and title are fuzzy —
 * spelled differently on the board, in the confirmation email, and in the
 * rejection three weeks later — while the req id is usually repeated verbatim in
 * all three. It is also what makes the fallback dedupe key trustworthy enough to
 * use at all.
 *
 * Read from the URL rather than the page because the URL is available before
 * anything is parsed, survives in exports, and does not depend on markup that
 * changes without notice.
 *
 * Every matcher here fails closed. Returning `null` costs a dedupe opportunity;
 * returning a wrong id joins two unrelated applications, so a shape that is not
 * recognised with confidence is not guessed at.
 */

export type AtsName = 'greenhouse' | 'lever' | 'ashby' | 'workday'

export interface AtsIdentity {
  ats: AtsName
  reqId: string
}

/** Lever and Ashby both key postings by UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Workday appends the requisition to the last path segment, after an
 * underscore: `…/job/San-Francisco/Software-Engineer_R-12345`.
 *
 * At least one letter is required. Titles carry underscores of their own —
 * `Software-Engineer-Intern_Summer_2026` — and since only the text after the
 * *last* underscore is considered, allowing a bare digit run turned `2026` into
 * a requisition id. Two internships at one employer then shared a join key and
 * `findDuplicate` called them the same posting: the exact silent wrong merge
 * this file is arranged to prevent. A requisition that is genuinely all digits
 * is now missed instead, which is the direction that fails safely.
 *
 * The trailing `-1` group was added after the first real Workday URL was read,
 * and every case above had been written without one: `R28643-1`, from a live
 * Premera posting. Workday appends a repost counter to the requisition, so the
 * shape this file had anticipated — `R-12345`, the hyphen sitting between the
 * letters and the digits — is one of two, and the pattern matched the invented
 * one. Real Workday requisitions were returning `null`, which cost the join key
 * silently: `findDuplicate` falls back to the canonical URL and the requisition
 * column simply stayed empty.
 *
 * The counter is **kept, not stripped**. `R28643-1` and `R28643-2` are a posting
 * and its repost, and this file's standing bias is that missing a merge is
 * cheaper than making a wrong one.
 */
const WORKDAY_REQ = /^[A-Z]{1,5}-?\d{3,}(-\d+)?$/i

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean)
}

function last(values: string[]): string | undefined {
  return values[values.length - 1]
}

/** Greenhouse: `boards.greenhouse.io/acme/jobs/4012345`, or a company subdomain. */
function greenhouseHost(url: URL): string | null {
  if (!/(^|\.)greenhouse\.io$/.test(url.hostname)) return null

  const parts = segments(url)
  const index = parts.lastIndexOf('jobs')
  const candidate = index >= 0 ? parts[index + 1] : undefined

  return candidate && /^\d+$/.test(candidate) ? candidate : null
}

/** Lever: `jobs.lever.co/acme/<uuid>`, sometimes with `/apply` appended. */
function lever(url: URL): string | null {
  if (!/(^|\.)lever\.co$/.test(url.hostname)) return null

  // `/apply` and `/thanks` trail the id rather than replacing it.
  const candidate = segments(url).find((part) => UUID.test(part))

  return candidate ? candidate.toLowerCase() : null
}

/** Ashby: `jobs.ashbyhq.com/acme/<uuid>`. */
function ashbyHost(url: URL): string | null {
  if (!/(^|\.)ashbyhq\.com$/.test(url.hostname)) return null

  const candidate = segments(url).find((part) => UUID.test(part))

  return candidate ? candidate.toLowerCase() : null
}

/** A Greenhouse board embedded in a company's own careers page. */
function greenhouseEmbedded(url: URL): string | null {
  const embedded = url.searchParams.get('gh_jid')

  return embedded && /^\d+$/.test(embedded) ? embedded : null
}

/** An Ashby board embedded in a company's own careers page. */
function ashbyEmbedded(url: URL): string | null {
  const embedded = url.searchParams.get('ashby_jid')

  return embedded && UUID.test(embedded) ? embedded.toLowerCase() : null
}

/**
 * Workday: `acme.wd1.myworkdayjobs.com/en-US/External/job/Location/Title_R-12345`.
 *
 * The tenant sits in the hostname and the req id in the final segment, so both
 * have to be present — a Workday URL for the board itself, with no job in it,
 * yields nothing.
 */
function workday(url: URL): string | null {
  if (!/(^|\.)myworkdayjobs\.com$/.test(url.hostname)) return null

  const tail = last(segments(url))
  if (!tail) return null

  const underscore = tail.lastIndexOf('_')
  if (underscore < 0) return null

  const candidate = tail.slice(underscore + 1)

  // Workday writes requisitions in upper case; folding them makes the same
  // posting reached through a differently-cased link compare equal.
  return WORKDAY_REQ.test(candidate) ? candidate.toUpperCase() : null
}

type Matcher = { ats: AtsName; extract: (url: URL) => string | null }

/**
 * Host-anchored matchers run first. The hostname is definitive — a Lever URL is
 * a Lever posting — whereas a query parameter can be present on any page. With
 * the embedded readers first, a stray `gh_jid` on a Lever link won the match and
 * produced a Greenhouse id for a Lever posting.
 */
const HOST_MATCHERS: readonly Matcher[] = [
  { ats: 'greenhouse', extract: greenhouseHost },
  { ats: 'lever', extract: lever },
  { ats: 'ashby', extract: ashbyHost },
  { ats: 'workday', extract: workday },
]

/** Only consulted when the host itself says nothing. */
const EMBEDDED_MATCHERS: readonly Matcher[] = [
  { ats: 'greenhouse', extract: greenhouseEmbedded },
  { ats: 'ashby', extract: ashbyEmbedded },
]

/**
 * Identifies the ATS and requisition id behind a posting URL, or `null` when the
 * URL is not a shape this knows.
 */
export function identifyAts(rawUrl: string): AtsIdentity | null {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return null
  }

  for (const { ats, extract } of [...HOST_MATCHERS, ...EMBEDDED_MATCHERS]) {
    const reqId = extract(url)
    if (reqId) return { ats, reqId }
  }

  return null
}

/** Convenience for callers that only want the key. */
export function extractAtsReqId(rawUrl: string): string | null {
  return identifyAts(rawUrl)?.reqId ?? null
}
