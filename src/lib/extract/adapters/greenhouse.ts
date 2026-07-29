import type { Adapter, ExtractedFields } from '../types'
import { at, readScriptJson } from '../tiers/appstate'
import { readMeta } from '../tiers/meta'
import { cleanText, firstText } from '../text'
import { inferWorkMode } from '../workmode'

/**
 * Greenhouse — `job-boards.greenhouse.io`, and the older `boards.greenhouse.io`
 * which now redirects to it.
 *
 * The notable thing about this adapter is what it does not have: **Greenhouse
 * emits no JSON-LD.** The checked-in fixture is a real capture and contains not
 * one `application/ld+json` block. Decision 5 ranks JSON-LD first on the
 * argument that boards emit it for Google Jobs indexing; that argument holds for
 * Lever and does not hold here, which is why this adapter's best tier is the
 * page's own state blob and its fallback is a handful of selectors.
 */

/** Greenhouse serves its boards from Remix; the loader data holds the posting. */
const REMIX_STATE = [
  /window\.__remixContext\s*=\s*(\{[\s\S]*\})\s*;/,
  /window\.__remixContext\s*=\s*(\{[\s\S]*?\})\s*;/,
]

/**
 * Finds the job post inside the Remix loader data.
 *
 * Searched for by shape rather than by route key. The key is
 * `routes/$url_token_.jobs_.$job_post_id`, which is Greenhouse's own file path
 * — it changes whenever they rename a route file, and nothing would tell us it
 * had. An object under `loaderData` carrying both `title` and `company_name` is
 * the posting whatever the route is called.
 */
function jobPost(state: unknown): Record<string, unknown> | null {
  const routes = at(state, 'state', 'loaderData')
  if (typeof routes !== 'object' || routes === null) return null

  for (const route of Object.values(routes as Record<string, unknown>)) {
    const post = at(route, 'jobPost')
    if (
      typeof post === 'object' &&
      post !== null &&
      'title' in post &&
      'company_name' in post
    ) {
      return post as Record<string, unknown>
    }
  }

  return null
}

function readAppState(document: Document): Partial<ExtractedFields> {
  const post = jobPost(readScriptJson(document, REMIX_STATE))
  if (!post) return {}

  const location = cleanText(
    typeof post.job_post_location === 'string'
      ? post.job_post_location
      : (at(post, 'location', 'name') as string | undefined),
  )

  return {
    company: cleanText(post.company_name as string | undefined),
    jobTitle: cleanText(post.title as string | undefined),
    location,
    workMode: inferWorkMode(location),
    // No requisition id, and the blob is exactly why. It carries
    // `hiring_plan_id` — 6368940002 on the posting this fixture came from —
    // sitting one key away from the title and looking every bit like an id
    // worth keying on. The posting is addressed by 8433948002. They are
    // different numbers for different things, and `hiring_plan_id` is not even
    // per-posting: a hiring plan spans every opening on it. Writing it into
    // `atsReqId` would hand the dedupe fallback a key shared by unrelated
    // roles at one employer, which is the silent wrong merge decision 7 is
    // arranged to prevent. The requisition comes from the URL, where
    // `deriveJoinKeys` already reads it.
    //
    // `pay_ranges` is the other thing in here worth naming. It is present and
    // empty on this capture — salary is stated in prose instead — so its shape
    // when populated is unknown, and `lib/extract/salary.ts` does not parse
    // shapes it has not seen.
  }
}

/**
 * Selectors, and the page title.
 *
 * `<title>` is the only place on a Greenhouse job page that names the employer
 * in the markup — the logo has it in `alt` text, but as a filename-ish string
 * with " Logo" appended. The phrasing is fixed and long enough to anchor on:
 * "Job Application for {title} at {company}". The greedy first group takes the
 * *last* " at ", so a role called "Engineer at Scale" still lands correctly.
 */
function readDom(document: Document): Partial<ExtractedFields> {
  const fromTitle = /^Job Application for (.+) at (.+)$/.exec(
    cleanText(document.title) ?? '',
  )

  const location = firstText(document, ['.job__location', '.job__header .location'])

  return {
    company: cleanText(fromTitle?.[2]),
    jobTitle:
      firstText(document, ['.job__title h1', '.job__header h1', 'h1.app-title']) ??
      cleanText(fromTitle?.[1]),
    location,
    workMode: inferWorkMode(location),
  }
}

export const greenhouse: Adapter = {
  name: 'greenhouse',
  version: 1,
  matches: (url) => /(^|\.)greenhouse\.io$/.test(url.hostname),
  readers: [
    { tier: 'appstate', read: readAppState },
    { tier: 'dom', read: readDom },
    { tier: 'meta', read: readMeta },
  ],
}

/** Exported for the fixture tests, which check each tier on its own. */
export const greenhouseReaders = { readAppState, readDom }
