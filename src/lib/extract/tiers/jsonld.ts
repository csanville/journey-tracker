import type { ExtractedFields } from '../types'
import { parseBaseSalary } from '../salary'
import { cleanText } from '../text'
import { inferWorkMode, workModeFromLocationType } from '../workmode'

/**
 * The top tier: schema.org `JobPosting` in a `<script type="application/ld+json">`.
 *
 * Preferred over everything because it is the one place a board states what a
 * field *means* rather than how it should look. It also changes slowly: boards
 * emit it for Google Jobs indexing, so breaking it costs them search traffic
 * (decision 5).
 *
 * **It is not universal, and the roadmap assumed it was.** Greenhouse — half of
 * this phase's launch target — emits none at all; the checked-in fixture is a
 * real capture and contains zero `ld+json` blocks. Lever emits a good one. So
 * this tier is the best answer when present and simply absent otherwise, which
 * is why the tiers below it are not a formality.
 */

type Unknowns = Record<string, unknown>

function asObject(value: unknown): Unknowns | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Unknowns)
    : null
}

function typesOf(node: Unknowns): string[] {
  const raw = node['@type']
  const list = Array.isArray(raw) ? raw : [raw]

  return list.filter((value): value is string => typeof value === 'string')
}

/**
 * Every object in a JSON-LD payload, flattened.
 *
 * Boards nest a `JobPosting` in every arrangement the spec allows: bare, inside
 * a top-level array, under `@graph`, and occasionally inside `mainEntity` of a
 * `WebPage`. Walking the whole tree costs nothing on a document this size and
 * removes a class of "works on one board" bugs.
 */
function walk(value: unknown, out: Unknowns[] = [], depth = 0): Unknowns[] {
  // A cycle is impossible in parsed JSON, but a pathologically nested document
  // is not, and this runs on every page load.
  if (depth > 12) return out

  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, depth + 1)
    return out
  }

  const node = asObject(value)
  if (!node) return out

  out.push(node)
  for (const child of Object.values(node)) walk(child, out, depth + 1)

  return out
}

/** Parses every JSON-LD block on the page, skipping any that is not valid JSON. */
function jsonLdNodes(document: Document): Unknowns[] {
  const nodes: Unknowns[] = []

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      walk(JSON.parse(script.textContent ?? ''), nodes)
    } catch {
      // A malformed block is common enough not to be worth reporting, and a
      // second block on the same page is often fine.
    }
  }

  return nodes
}

function organizationName(value: unknown): string | null {
  if (typeof value === 'string') return cleanText(value)

  const org = asObject(value) ?? asObject(Array.isArray(value) ? value[0] : null)

  return org ? cleanText(typeof org.name === 'string' ? org.name : null) : null
}

/**
 * An ATS writing "this field is not set" into the field.
 *
 * iCIMS emits the literal string `UNAVAILABLE` for every part of a posting its
 * tenant left blank, and both captured iCIMS pages are full of it —
 * `addressRegion`, `streetAddress`, `skills`, `workHours`, `industry`,
 * `educationRequirements`. Only the address parts reach a stored field, and
 * there it turns a remote job's location into `Remote, UNAVAILABLE, US`.
 *
 * Rejected here rather than in the iCIMS adapter because this is the shared
 * reader that assembles the string, and because the generic adapter is what
 * reads the other iCIMS surface — the career-home template, which has the same
 * sentinel and no adapter of its own. A board with a genuine place called
 * UNAVAILABLE loses a location; the alternative is every blank field on the
 * vendor's postings reading as a place.
 */
const NOT_A_VALUE = /^unavailable$/i

/** `PostalAddress` rendered the way a person would write it. */
function formatAddress(place: unknown): string | null {
  const node = asObject(place)
  if (!node) return typeof place === 'string' ? cleanText(place) : null

  const address = asObject(node.address)
  if (!address) return cleanText(typeof node.name === 'string' ? node.name : null)

  const parts = ['addressLocality', 'addressRegion', 'addressCountry']
    .map((key) => {
      const value = address[key]
      // `addressCountry` is sometimes a nested `Country` object rather than a
      // string, and `[object Object]` in a location field is worse than a gap.
      const text = cleanText(
        typeof value === 'string' ? value : (asObject(value)?.name as string | undefined),
      )

      return text && NOT_A_VALUE.test(text) ? null : text
    })
    .filter((part): part is string => part !== null)

  return parts.length ? parts.join(', ') : null
}

function locationOf(node: Unknowns): string | null {
  const places = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation]

  // Multi-location postings are ordinary. Duplicates are too, because the same
  // city arrives once per office, so they are collapsed rather than repeated.
  const formatted = [...new Set(places.map(formatAddress).filter(Boolean))]

  return formatted.length ? cleanText(formatted.join(' · ')) : null
}

/**
 * The page's `JobPosting` node, for an adapter that needs a key this tier does
 * not read.
 *
 * Exported rather than duplicated so that a board-specific reader and the
 * general one below cannot disagree about *which* node is the posting — the
 * walk, the `@type` handling and the graph flattening are all in `jsonLdNodes`,
 * and a second implementation of any of them is a second set of bugs. The
 * caller gets the node and decides what to do with the keys this one declines.
 */
export function jobPostingFrom(document: Document): Unknowns | null {
  return jsonLdNodes(document).find((node) => typesOf(node).includes('JobPosting')) ?? null
}

export function readJsonLd(document: Document): Partial<ExtractedFields> {
  const posting = jobPostingFrom(document)
  if (!posting) return {}

  const location = locationOf(posting)

  return {
    company: organizationName(posting.hiringOrganization),
    jobTitle: cleanText(typeof posting.title === 'string' ? posting.title : null),
    location,
    // `applicantLocationRequirements` is not consulted, though it is tempting:
    // it says where an applicant may *live*, which a remote posting fills in and
    // an onsite one also fills in. It answers a different question.
    workMode: workModeFromLocationType(posting.jobLocationType) ?? inferWorkMode(location),
    salary: parseBaseSalary(posting.baseSalary),
    // `identifier` is deliberately not read. See the note in `../index.ts`:
    // what boards put there is their internal record id, which is a different
    // number from the requisition in the URL, and letting it win would hand
    // `deriveJoinKeys` a key that matches nothing.
  }
}
