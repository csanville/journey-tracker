import type { ExtractedFields } from '../types'
import { cleanText } from '../text'
import { inferWorkMode } from '../workmode'

/**
 * The last tier, and the only one that works on a site nobody has adapted.
 *
 * OpenGraph and Twitter card tags are on nearly every job page because they are
 * what a link preview renders from. That ubiquity is the whole value: a posting
 * on a board this extension has never heard of still arrives with a title
 * filled in (decision 5).
 *
 * It ranks *last* rather than second — where the roadmap put it — because these
 * tags are marketing copy, not fields. Both launch boards demonstrate the
 * problem in the checked-in fixtures: Lever's `og:title` is
 * `"Lever Demo 2 - Software Engineer"`, and Greenhouse's `og:description` holds
 * the location. Anything that knows the site knows better.
 */

/**
 * Reads `content`, then `value`.
 *
 * `content` is the attribute the specification defines. `value` is what Lever
 * actually ships on its Twitter card tags — see the fixture — and a reader that
 * only knew the spelling in the spec would silently find nothing there.
 */
function metaValue(document: Document, selector: string): string | null {
  const element = document.querySelector(selector)
  if (!element) return null

  return cleanText(element.getAttribute('content') ?? element.getAttribute('value'))
}

function firstMeta(document: Document, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const value = metaValue(document, selector)
    if (value) return value
  }

  return null
}

/**
 * Twitter cards carry labelled extras as `label1`/`data1` pairs, which is the
 * one part of this tier that names its own fields. Lever puts the location
 * there.
 */
function labelledData(document: Document, wanted: RegExp): string | null {
  for (const index of [1, 2]) {
    const label = metaValue(document, `meta[name="twitter:label${index}"]`)
    if (label && wanted.test(label)) {
      const data = metaValue(document, `meta[name="twitter:data${index}"]`)
      if (data) return data
    }
  }

  return null
}

export function readMeta(document: Document): Partial<ExtractedFields> {
  const location = labelledData(document, /location|city|office/i)

  return {
    // No company. `og:site_name` would be the field for it and neither launch
    // board sets it, while `<title>` and `og:title` weld the employer to the
    // title in a different order on each — `"Company - Title"` on Lever,
    // `"Job Application for Title at Company"` on Greenhouse. Splitting those
    // needs site knowledge, so it happens in the adapters, where the knowledge
    // is. Guessing here would put an employer name in the join key on the
    // strength of a hyphen.
    jobTitle: firstMeta(document, [
      'meta[property="og:title"]',
      'meta[name="og:title"]',
      'meta[name="twitter:title"]',
    ]),
    location,
    workMode: inferWorkMode(location),
  }
}
