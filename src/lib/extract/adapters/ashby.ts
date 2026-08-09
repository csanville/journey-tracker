import type { WorkMode } from '../../types'
import type { Adapter, ExtractedFields } from '../types'
import { at, readScriptJson } from '../tiers/appstate'
import { readJsonLd } from '../tiers/jsonld'
import { readMeta } from '../tiers/meta'
import { cleanText } from '../text'

/**
 * Ashby — `jobs.ashbyhq.com`.
 *
 * Ashby serves an **empty SPA shell**: `<div id="root">` holding a loading
 * spinner, with the posting rendered client-side under hashed CSS-module class
 * names that change with every deploy. There is nothing stable to select on, so
 * unlike Greenhouse and Lever this adapter has no selector-based DOM tier —
 * writing one would be inventing site knowledge that does not survive a
 * release.
 *
 * What it has instead is two independent server-rendered sources, both present
 * in the markup before React runs — which also means neither depends on the
 * page having finished hydrating when the content script fires at
 * `document_idle`:
 *
 * 1. a schema.org `JobPosting` in JSON-LD, and
 * 2. `window.__appData`, whose `posting` key is the board's own record.
 *
 * Between them every field this project reads is covered twice.
 */

/**
 * Ashby's own state blob.
 *
 * The assignment is followed by the Vite bundle loader in the same script, and
 * that loader contains `};` (it ends a `link.onload = function () {…}`), so the
 * greedy pattern runs past the JSON and fails to parse. The lazy one is what
 * succeeds. Both are passed for the reason `readScriptJson` documents — a regex
 * cannot balance braces — and the checked-in fixture keeps that trailing
 * function expression precisely so this ordering stays exercised.
 */
const APP_DATA = [
  /window\.__appData\s*=\s*(\{[\s\S]*\})\s*;/,
  /window\.__appData\s*=\s*(\{[\s\S]*?\})\s*;/,
]

/**
 * `workplaceType` is a closed enum rather than prose, so it is looked up rather
 * than sniffed.
 *
 * `inferWorkMode` exists for strings a human wrote into a location field. This
 * is not one: Ashby emits exactly these three values, and running them through
 * pattern matching would only add ways to be wrong — a fourth value Ashby
 * invents later should read as "nothing said" and fall through, not as whatever
 * word it happens to contain.
 */
const WORKPLACE_TYPES: Record<string, WorkMode> = {
  Remote: 'remote',
  Hybrid: 'hybrid',
  OnSite: 'onsite',
}

/**
 * JSON-LD, minus the one field Ashby gets wrong.
 *
 * **Ashby reports `jobLocationType: "TELECOMMUTE"` on hybrid postings.** It is
 * emitted for everything except `OnSite`, so it does not mean "remote" on this
 * board, it means "not purely in an office" — and `workModeFromLocationType`
 * quite correctly reads the schema.org term as remote. Verified across Ramp,
 * Linear and Notion postings whose `workplaceType` is `Hybrid`; the checked-in
 * fixture is one of them.
 *
 * That matters because `TIER_ORDER` puts `jsonld` above `appstate` and
 * `mergeTiers` takes the first non-null answer, so the wrong value would win
 * over the exact enum `readAppState` reads two tiers down — and it would win
 * silently, on the field the user is least likely to re-check. `TIER_ORDER` is
 * global and cannot be reordered per adapter, so the fix is to decline the
 * field here: this reader answers everything JSON-LD is good for and abstains
 * on the one thing it is not.
 *
 * The cost is real and worth stating: `buildSnapshot` drops inline non-JSON-LD
 * scripts, so a re-parsed Ashby snapshot has no `appstate` tier and comes back
 * with no work mode at all. A gap the user can fill from a dropdown is the
 * better failure than a confident "Remote" on a job that wants three days a
 * week in New York.
 */
function readJsonLdFields(document: Document): Partial<ExtractedFields> {
  const { workMode: _ashbyCallsHybridRemote, ...rest } = readJsonLd(document)

  return rest
}

/**
 * Ashby states the location as a primary plus a list of secondaries. They are
 * joined with the same ` · ` the JSON-LD tier uses for multi-location postings,
 * so a record reads the same however it was extracted.
 */
function locationOf(posting: Record<string, unknown>): string | null {
  const secondary = Array.isArray(posting.secondaryLocationNames)
    ? posting.secondaryLocationNames
    : []

  const names = [posting.locationName, ...secondary]
    .map((name) => cleanText(typeof name === 'string' ? name : null))
    .filter((name): name is string => name !== null)

  // Deduplicated because the primary reappearing among the secondaries is an
  // ordinary way for an employer to fill the form in.
  return names.length ? cleanText([...new Set(names)].join(' · ')) : null
}

/**
 * Whether the blob says this page is a board's listing rather than a posting.
 *
 * `jobs.ashbyhq.com/{org}` is inside `content_scripts.matches` and serves the
 * same `__appData` with `posting: null`. The tiers that read the posting
 * naturally say nothing there — but `og:title` on a real listing page is
 * "Ramp Jobs", and the meta tier would happily hand that back as a job title.
 * `isWorthOffering` needs only a title, so the panel would offer to track
 * "Ramp Jobs" as a role, which is decision 12's corroding false positive.
 *
 * Only an *explicit* null counts. A missing blob means a re-parsed snapshot
 * (`buildSnapshot` drops inline scripts) or a redesign, and suppressing the
 * lower tiers there would throw away a real posting to avoid a hypothetical
 * one.
 *
 * Greenhouse and Lever board pages have the same shape of problem — `og:title`
 * is "Discord" and "Lever Demo 2 jobs" respectively — and neither is fixed
 * here. Neither board states "this is not a posting" anywhere a parser can
 * read it, so the fix for them is a different and larger one.
 */
function isBoardListing(document: Document): boolean {
  const app = readScriptJson(document, APP_DATA)

  return app !== null && at(app, 'posting') === null
}

function readAppState(document: Document): Partial<ExtractedFields> {
  const app = readScriptJson(document, APP_DATA)

  const posting = at(app, 'posting')
  if (typeof posting !== 'object' || posting === null) return {}

  const post = posting as Record<string, unknown>
  const workplaceType = typeof post.workplaceType === 'string' ? post.workplaceType : ''

  return {
    company: cleanText(at(app, 'organization', 'name') as string | undefined),
    jobTitle: cleanText(typeof post.title === 'string' ? post.title : null),
    location: locationOf(post),
    workMode: WORKPLACE_TYPES[workplaceType] ?? null,
    // No `atsReqId`. `posting.id` is the requisition and it is genuinely the
    // right number — but it is the same number `normalize/ats.ts` already reads
    // out of the URL, where it is available before any of this runs and
    // survives into exports. Decision 7's rule holds: the URL is the source for
    // that key, and no adapter writes it.
    //
    // No salary either. `compensationTierSummary` is display prose —
    // "$189K – $330K • Offers Equity" — and `salary.ts` takes schema.org shapes
    // only, by design. The JSON-LD tier above already carries the same figures
    // as a real `MonetaryAmount`, so there is nothing to recover here.
  }
}

/**
 * The page title, which on Ashby is `"{Title} @ {Company}"`.
 *
 * This is the whole DOM tier, and it is markup-free on purpose — see the note
 * at the top of the file about hashed class names. `<title>` is server-rendered
 * and consistent across every board checked, which makes it the one selector-
 * free thing on the page worth reading.
 *
 * The first group is greedy, so it takes the *last* ` @ ` and a role called
 * "Engineer @ Scale" still lands correctly. Same trick as Greenhouse's " at ".
 */
function readDom(document: Document): Partial<ExtractedFields> {
  if (isBoardListing(document)) return {}

  const fromTitle = /^(.+) @ (.+)$/.exec(cleanText(document.title) ?? '')

  return {
    company: cleanText(fromTitle?.[2]),
    jobTitle: cleanText(fromTitle?.[1]),
    // No work mode. The only thing this tier can see is the title, and a title
    // is exactly the haystack `workmode.ts` refuses to search: "Remote Sensing
    // Engineer" is a real job.
  }
}

/** The shared link-preview tier, silenced on a board's listing page. */
function readMetaFields(document: Document): Partial<ExtractedFields> {
  return isBoardListing(document) ? {} : readMeta(document)
}

export const ashby: Adapter = {
  name: 'ashby',
  version: 1,
  matches: (url) => /(^|\.)ashbyhq\.com$/.test(url.hostname),
  readers: [
    { tier: 'jsonld', read: readJsonLdFields },
    { tier: 'appstate', read: readAppState },
    { tier: 'dom', read: readDom },
    { tier: 'meta', read: readMetaFields },
  ],
}

/** Exported for the fixture tests, which check each tier on its own. */
export const ashbyReaders = { readJsonLdFields, readAppState, readDom, readMetaFields }
