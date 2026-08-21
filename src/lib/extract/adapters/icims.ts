import type { Adapter, ExtractedFields } from '../types'
import { readJsonLd } from '../tiers/jsonld'
import { readMeta } from '../tiers/meta'
import { inferWorkMode } from '../workmode'
import { cleanText, firstText } from '../text'

/**
 * iCIMS — `careers-<tenant>.icims.com/jobs/<id>/<slug>/job`, and the vendor's
 * own `careers.icims.com/careers-home/jobs/<id>`.
 *
 * **The manifest names neither, and that is this board's defining fact.** A
 * Chrome match pattern's host wildcard "must be the first or only character,
 * and it must be followed by a period or forward slash", so `careers-*.icims.com`
 * — the shape that would have named the career portals and nothing else — is not
 * expressible. The only host pattern that reaches iCIMS is `*.icims.com`, and on
 * iCIMS the recruiter console lives on the *same hosts* as the applicant portal,
 * under `/icims2/servlet/…`; the internal employee boards are
 * `internal-<tenant>.icims.com`, which an infix wildcard cannot exclude either.
 * So iCIMS is read by the capture gesture — `activeTab`, one tab, at the moment
 * the user asks — which is what decision 2 says the long tail is for. This
 * adapter runs when that gesture lands on an iCIMS page, and never
 * automatically.
 *
 * **The posting is not in the document the gesture lands on.** See
 * `content/frames.ts`: the classic portal is a shell around a same-origin
 * iframe. Everything below reads whichever document the posting turned out to
 * be in, which is the frame's on the classic portal and the top one on
 * career-home — and both surfaces route here, because `matches` is the whole
 * `icims.com` domain. The career-home template has no reader of its own in the
 * tiers below; it is read by the shared ones, exactly as `generic` read it
 * before this adapter existed.
 *
 * What this adds over `generic` is the requisition, and it is the reason the
 * adapter exists at all — `readJsonLd` and `readMeta` do the rest, exactly as
 * they did when `generic@1` read this board at 0.86.
 */

/**
 * The requisition, and the first time an adapter's id has *disagreed* with the
 * URL's.
 *
 * `extract/index.ts` reserves page-read requisitions for an adapter that finds
 * "a genuinely public requisition number on the page", and Workday earned that
 * by agreement: its `identifier.value` is the same string the URL is addressed
 * by, and `ats.test.ts` asserts they still match. iCIMS states `ID 2026-8287`
 * on a posting whose URL says `/jobs/8287/`. They are two different ids for one
 * job.
 *
 * The one that goes in the record is the page's, and the reason is decision 7's
 * own argument rather than an exception to it. The key earns its place by being
 * "repeated verbatim" in the confirmation email and the rejection three weeks
 * later, and what iCIMS repeats is `2026-8287`: it is the number shown to the
 * candidate, and the year prefix is what makes it unique across a tenant's
 * postings. `8287` is an internal row id that the user will never see again —
 * the exact failure the reserved exception was worded to prevent, with the URL
 * on the wrong side of it this time.
 *
 * **`ats.ts` therefore gets no iCIMS matcher.** Adding one would derive `8287`
 * from the URL and hand `deriveJoinKeys` a fallback that is wrong rather than
 * absent, on every page where this adapter came up empty. A missing key costs a
 * merge; a wrong one merges two jobs.
 */
const REQ_LABEL = /^(job\s+|requisition\s+|req\s+)?(id|number)$/i

/**
 * What may be taken from a field labelled like a requisition.
 *
 * The label is tenant-configurable, so the value carries the refusal. A
 * requisition is one token with a digit in it: `2026-8287`, `8287`, `R-4471`.
 * Anything with a space in it is a sentence that a tenant put under a heading
 * this pattern happened to like, and a sentence in the requisition column would
 * join nothing to nothing.
 */
const REQ_VALUE = /^(?=[^\s]*\d)[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/

/**
 * The `dt`/`dd` pairs iCIMS renders under the job title.
 *
 * `ID`, `Category`, `Position Type` on the captured posting; tenants add,
 * remove and rename them, which is why this reads the labels rather than
 * counting positions.
 */
function headerFields(document: Document): Map<string, string> {
  const fields = new Map<string, string>()

  for (const tag of document.querySelectorAll('.iCIMS_JobHeaderTag')) {
    const label = cleanText(tag.querySelector('.iCIMS_JobHeaderField')?.textContent)
    const value = cleanText(tag.querySelector('.iCIMS_JobHeaderData')?.textContent)

    // First wins, so a second field with a duplicate label cannot displace the
    // one nearest the title.
    if (label && value && !fields.has(label.toLowerCase())) {
      fields.set(label.toLowerCase(), value)
    }
  }

  return fields
}

/**
 * The location, read from the label iCIMS puts beside it.
 *
 * `<span class="sr-only field-label">Job Locations</span>` followed by the
 * value, which is the accessibility markup doing the job a data attribute
 * would: the label is in the page because a screen reader needs it, so it is
 * the one part of this template that cannot be restyled away without someone
 * noticing.
 */
function headerLocation(document: Document): string | null {
  for (const label of document.querySelectorAll('.iCIMS_JobsTable .field-label')) {
    if (!/location/i.test(label.textContent ?? '')) continue

    const value = cleanText(label.nextElementSibling?.textContent)
    if (value) return value
  }

  return null
}

function readIcimsDom(document: Document): Partial<ExtractedFields> {
  const fields: Partial<ExtractedFields> = {}

  for (const [label, value] of headerFields(document)) {
    if (REQ_LABEL.test(label) && REQ_VALUE.test(value)) {
      fields.atsReqId = value
      break
    }
  }

  // Title and location are fallbacks and nothing more. `mergeTiers` orders by
  // tier, so on any tenant that emits JSON-LD — every one seen so far — the
  // higher tier has already answered both and these are never consulted. They
  // are here for the tenant that does not, where the alternative is a page that
  // reads as nothing at all.
  const title = firstText(document, ['h1.iCIMS_Header'])
  if (title) fields.jobTitle = title

  const location = headerLocation(document)
  if (location) {
    fields.location = location
    // `US-Remote` is how the captured posting writes it, and `inferWorkMode`
    // reads that. Where the JSON-LD answered, this loses to it on tier.
    const workMode = inferWorkMode(location)
    if (workMode) fields.workMode = workMode
  }

  return fields
}

/** Exported for the fixture tests, which check each tier on its own. */
export const icimsReaders = { dom: readIcimsDom }

export const icims: Adapter = {
  name: 'icims',
  version: 1,
  // Every tenant, every surface. Anchored on the domain rather than a suffix
  // match, so `noticims.com` is not accepted — the trick `ats.ts` guards
  // against too. This decides which adapter reads a page, not which pages may
  // be read; the manifest still names no iCIMS host at all.
  matches: (url) => /(^|\.)icims\.com$/.test(url.hostname),
  readers: [
    { tier: 'jsonld', read: readJsonLd },
    { tier: 'dom', read: readIcimsDom },
    { tier: 'meta', read: readMeta },
  ],
}
