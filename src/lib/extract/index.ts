import { ashby } from './adapters/ashby'
import { icims } from './adapters/icims'
import { workday } from './adapters/workday'
import { generic } from './adapters/generic'
import { greenhouse } from './adapters/greenhouse'
import { lever } from './adapters/lever'
import { mergeTiers, scoreConfidence } from './merge'
import type { Adapter, Extraction, TierResult } from './types'

export type {
  Adapter,
  ExtractedFields,
  Extraction,
  FieldName,
  Tier,
  TierResult,
} from './types'
export { FIELD_NAMES, TIER_ORDER } from './types'
export { mergeTiers, scoreConfidence } from './merge'

/**
 * Reading a posting off the page (decision 5).
 *
 * Three things about this layer are worth knowing before changing it.
 *
 * **The URL is not extracted.** It is reported by the content script from its
 * own `location.href`, which is what keeps the `tabs` permission out of the
 * manifest (decision 2), and `atsReqId` is then derived from it by the existing
 * normalization layer. No adapter here writes `atsReqId`, even where the page
 * hands one over: schema.org's `identifier` and Greenhouse's `internal_job_id`
 * are both the board's *internal* record id, a different number from the
 * requisition the URL is addressed by. Letting either win over
 * `deriveJoinKeys`' URL reading would put a key in the record that matches
 * nothing the user will ever see again — the wrong-merge failure decision 7 is
 * arranged around, arriving through a new door. The field stays in
 * `ExtractedFields` for an adapter that finds a genuinely public requisition
 * number on the page.
 *
 * **Two adapters now write it, on opposite evidence.** Workday's JSON-LD
 * `identifier.value` is the requisition the URL is addressed by — checked
 * against two real postings, where the two agree once the counter Workday
 * appends to the slug is stripped, and `ats.test.ts` asserts they still do.
 * iCIMS states `ID 2026-8287` on a posting the URL addresses as `/jobs/8287/`,
 * and they are two different ids for one job; the page's is taken because it is
 * the one the candidate is shown and the one an email will repeat, which is what
 * decision 7 wants the key for. So the condition is not "the page agrees with
 * the URL" — that was Workday's evidence, not the rule. It is **the id a user
 * will see again**, and where the URL carries a different one, `ats.ts` is left
 * without a matcher for that board rather than given one that would fill the
 * column with an internal row id. `greenhouse` and `ashby` still write nothing
 * here, and the shared `jsonld` tier still reads no `identifier` at all.
 *
 * **Nothing here throws.** Every reader is written to return what it found and
 * shrug at what it did not, and `extract` catches anything that gets through
 * anyway. An adapter that throws on a redesigned page would take the panel's
 * fill button down with it, and a board redesigning is a certainty.
 *
 * **The tier order is not the roadmap's.** OpenGraph moved from second to last
 * on the evidence of both launch boards' real markup — see `types.ts`.
 */

/**
 * Ordered, most specific first. `generic` matches everything and must stay
 * last; it is the fallback, not a competitor.
 */
export const ADAPTERS: readonly Adapter[] = [
  greenhouse,
  lever,
  ashby,
  workday,
  icims,
  generic,
]

export function selectAdapter(rawUrl: string): Adapter {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return generic
  }

  return ADAPTERS.find((adapter) => adapter.matches(url)) ?? generic
}

/**
 * Runs the adapter for `url` over `document` and merges what the tiers found.
 *
 * `adapterVersion` is stored on the record so a snapshot can be re-parsed
 * knowing what produced it (decision 6), and matches the `manual@1` shape the
 * form already writes.
 */
export function extract(document: Document, url: string): Extraction {
  const adapter = selectAdapter(url)

  const results: TierResult[] = []
  for (const { tier, read } of adapter.readers) {
    try {
      results.push({ tier, fields: read(document) })
    } catch (error) {
      // One tier failing is not the page failing. A board that renamed a class
      // or shipped malformed state should cost the fields that tier owned, not
      // the whole extraction.
      console.warn('[JourneyTracker] tier failed', adapter.name, tier, error)
    }
  }

  const { fields, provenance } = mergeTiers(results)

  return {
    fields,
    provenance,
    source: adapter.name,
    adapterVersion: `${adapter.name}@${adapter.version}`,
    confidence: scoreConfidence(provenance),
  }
}

/** Whether an extraction found enough to be worth offering to the user. */
export function isWorthOffering(extraction: Extraction): boolean {
  // Company *or* title, not both. A page that yielded only one of them has
  // still saved a field of typing, and the form will not let a half-filled
  // record be saved anyway — it requires both, so the user is asked for the
  // missing one at exactly the right moment.
  return Boolean(extraction.fields.company ?? extraction.fields.jobTitle)
}
