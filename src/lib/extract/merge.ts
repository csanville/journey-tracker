import {
  EMPTY_FIELDS,
  FIELD_NAMES,
  TIER_ORDER,
  type ExtractedFields,
  type FieldName,
  type Tier,
  type TierResult,
} from './types'

/**
 * How much a tier's answer is worth, and how much a field is worth.
 *
 * These two tables are the whole confidence model. Kept as data rather than
 * folded into the merge so that changing what the number means is a visible
 * edit to a visible table.
 */
const TIER_WEIGHT: Record<Tier, number> = {
  jsonld: 1,
  appstate: 0.95,
  dom: 0.8,
  meta: 0.5,
}

/**
 * Company and title carry the record; the rest are conveniences.
 *
 * A parse that got the employer and the role right has done its job even with
 * every other field blank — those two are what the join keys are built from
 * (decision 7) and what the form refuses to save without.
 *
 * The four extras are 0.2 rather than 0.25 for a reason worth keeping: at 0.25
 * they summed to exactly 1, so a parse that found the location, work mode,
 * salary and requisition but no employer scored identically to one that found
 * the employer and nothing else. Those are not comparable outcomes — the second
 * is a record and the first is not — and a scale that ranked them equal was
 * saying something nobody meant. A test asserting the intent is what surfaced
 * it.
 */
const FIELD_WEIGHT: Record<FieldName, number> = {
  company: 1,
  jobTitle: 1,
  location: 0.2,
  workMode: 0.2,
  atsReqId: 0.2,
  salary: 0.2,
}

const TOTAL_WEIGHT = Object.values(FIELD_WEIGHT).reduce((sum, weight) => sum + weight, 0)

export interface Merged {
  fields: ExtractedFields
  provenance: Record<FieldName, Tier | null>
}

/**
 * Combines tier results field by field, strongest tier first.
 *
 * Per-field rather than whole-result on purpose. The real pages show why: on
 * Greenhouse the state blob has the company and the title but no location,
 * while the DOM has the location; on Lever the JSON-LD has all three but the
 * work mode only ever appears in a DOM class. Picking one winning tier would
 * throw away a field that a lower tier had and the winner did not, for no
 * benefit — a lower tier answering a question the higher tier declined is not a
 * disagreement.
 *
 * A tier is free to omit a key or to report `null`; both mean "nothing to say"
 * and neither blocks a weaker tier from answering.
 */
export function mergeTiers(results: readonly TierResult[]): Merged {
  const ordered = [...results].sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
  )

  const fields: ExtractedFields = { ...EMPTY_FIELDS }
  const provenance = Object.fromEntries(FIELD_NAMES.map((name) => [name, null])) as Record<
    FieldName,
    Tier | null
  >

  for (const result of ordered) {
    for (const name of FIELD_NAMES) {
      if (provenance[name] !== null) continue

      const value = result.fields[name]
      if (value === null || value === undefined) continue

      // The cast is the price of iterating a heterogeneous record by key; the
      // value came out of the same key it goes into.
      fields[name] = value as never
      provenance[name] = result.tier
    }
  }

  return { fields, provenance }
}

/**
 * A 0–1 score for how much of the record the page gave up, weighted by how much
 * the tier that gave it is worth.
 *
 * **Not a probability of correctness.** Nothing here has any way to know whether
 * the title it read is the right title; it knows which tier said so and how
 * central the field is. Read it as coverage-weighted-by-trust and it is useful —
 * it separates "JSON-LD named the employer" from "we inferred a title from a
 * link preview" — and read it as accuracy it will mislead, which is exactly the
 * mistake decision 3 warns about with protections that were recorded as
 * established when only their declaration had been checked.
 */
export function scoreConfidence(provenance: Record<FieldName, Tier | null>): number {
  const earned = FIELD_NAMES.reduce((sum, name) => {
    const tier = provenance[name]
    return tier === null ? sum : sum + FIELD_WEIGHT[name] * TIER_WEIGHT[tier]
  }, 0)

  return Math.round((earned / TOTAL_WEIGHT) * 100) / 100
}
