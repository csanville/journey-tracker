import type { Adapter, ExtractedFields } from '../types'
import { readJsonLd } from '../tiers/jsonld'
import { readMeta } from '../tiers/meta'
import { cleanText, firstAttr, firstText, splitOnce } from '../text'
import { inferWorkMode } from '../workmode'

/**
 * Lever — `jobs.lever.co`.
 *
 * The opposite shape to Greenhouse: Lever emits a genuine schema.org
 * `JobPosting`, so the top tier does most of the work and these selectors exist
 * for the fields it leaves out and for the day the block disappears.
 */

/**
 * Two ways to the employer's name, both indirect, because Lever names the
 * company nowhere in the posting body — the page is served from the company's
 * own board, so the board *is* the context.
 *
 * 1. `<title>`, which is `"{Company} - {Title}"`. Split only when there is
 *    exactly one separator: "Acme - Senior Engineer - Remote" has no reading
 *    that can be defended, so it yields nothing rather than "Acme - Senior
 *    Engineer" or a wrong half.
 * 2. The header logo's `alt` text, `"{Company} logo"`.
 *
 * The title is tried first because the logo's `alt` is whatever was typed into
 * a settings page, and is empty on plenty of boards.
 */
function companyOf(document: Document): string | null {
  const fromTitle = splitOnce(document.title, / - /)
  if (fromTitle) return fromTitle[0]

  const alt = firstAttr(
    document,
    ['.main-header-logo img', '.main-header-content img'],
    'alt',
  )

  return alt ? cleanText(alt.replace(/\s+logos?$/i, '')) : null
}

function readDom(document: Document): Partial<ExtractedFields> {
  const location = firstText(document, [
    '.posting-categories .location',
    '.posting-headline .location',
  ])

  // Lever's own label for remote/hybrid/onsite, when the employer sets it.
  const workplaceType = firstText(document, ['.posting-categories .workplaceTypes'])

  return {
    company: companyOf(document),
    jobTitle: firstText(document, ['.posting-headline h2', '.posting-header h2']),
    location,
    workMode: inferWorkMode(workplaceType, location),
  }
}

export const lever: Adapter = {
  name: 'lever',
  version: 1,
  matches: (url) => /(^|\.)lever\.co$/.test(url.hostname),
  readers: [
    { tier: 'jsonld', read: readJsonLd },
    { tier: 'dom', read: readDom },
    { tier: 'meta', read: readMeta },
  ],
}

/** Exported for the fixture tests, which check each tier on its own. */
export const leverReaders = { readDom }
