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
 * underscore: `…/job/San-Francisco/Software-Engineer_R-12345`. Anchored so a
 * job title that merely contains an underscore cannot produce a false id.
 */
const WORKDAY_REQ = /^[A-Z]{0,5}-?\d{3,}$/i

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean)
}

function last(values: string[]): string | undefined {
  return values[values.length - 1]
}

/**
 * Greenhouse: `boards.greenhouse.io/acme/jobs/4012345`, the same path under a
 * company subdomain, or `gh_jid` on an embedded board hosted elsewhere.
 */
function greenhouse(url: URL): string | null {
  const embedded = url.searchParams.get('gh_jid')
  if (embedded && /^\d+$/.test(embedded)) return embedded

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

  return candidate ?? null
}

/** Ashby: `jobs.ashbyhq.com/acme/<uuid>`, or `ashby_jid` when embedded. */
function ashby(url: URL): string | null {
  const embedded = url.searchParams.get('ashby_jid')
  if (embedded && UUID.test(embedded)) return embedded

  if (!/(^|\.)ashbyhq\.com$/.test(url.hostname)) return null

  return segments(url).find((part) => UUID.test(part)) ?? null
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

  return WORKDAY_REQ.test(candidate) ? candidate : null
}

const MATCHERS: ReadonlyArray<{ ats: AtsName; extract: (url: URL) => string | null }> = [
  { ats: 'greenhouse', extract: greenhouse },
  { ats: 'lever', extract: lever },
  { ats: 'ashby', extract: ashby },
  { ats: 'workday', extract: workday },
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

  for (const { ats, extract } of MATCHERS) {
    const reqId = extract(url)
    if (reqId) return { ats, reqId }
  }

  return null
}

/** Convenience for callers that only want the key. */
export function extractAtsReqId(rawUrl: string): string | null {
  return identifyAts(rawUrl)?.reqId ?? null
}
