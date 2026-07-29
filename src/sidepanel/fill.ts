import type { DetectionSummary } from '../lib/detection'
import { EMPTY_DRAFT, type Draft, type SaveContext } from './draft'

/**
 * Turning what a page said into what the form holds.
 *
 * Two rules shape all of it.
 *
 * **Fill, never clear.** A detection that found no location leaves the location
 * field as it was. The adapters report absence honestly — `null` means "the page
 * did not say", not "the page said nothing is there" — so blanking a field on
 * the strength of a missing one would delete the user's own answer to a question
 * the page never asked.
 *
 * **Nothing about the application.** Status, applied date, resume label, notes
 * and tags are what the *user* knows and the page cannot: a job board has no
 * opinion about whether you applied. Those fields are untouched by a fill, which
 * is also what makes filling an already-started record safe to offer.
 */

/** Only the fields a page can legitimately answer. */
const FILLABLE = [
  'company',
  'jobTitle',
  'url',
  'location',
  'workMode',
  'salary',
  'atsReqId',
] as const satisfies readonly (keyof Draft)[]

export type FillableField = (typeof FILLABLE)[number]

function fillValues(detection: DetectionSummary): Partial<Record<FillableField, string>> {
  const { fields } = detection

  return {
    company: fields.company ?? '',
    jobTitle: fields.jobTitle ?? '',
    // The URL is the one field that does not come from the fields bag: the
    // content script reported it from its own `location.href` (decision 2), so
    // it is always present and is the most trustworthy thing in the message.
    url: detection.url,
    location: fields.location ?? '',
    workMode: fields.workMode ?? '',
    salary: fields.salary?.raw ?? '',
    atsReqId: fields.atsReqId ?? '',
  }
}

/**
 * The draft a detection produces, layered over `base`.
 *
 * `base` defaults to an empty draft. Passing the current draft instead is what
 * makes "fill this in" work on a form the user has already started — the fields
 * the page knows about get answered, and everything else is left alone.
 */
export function draftFromDetection(
  detection: DetectionSummary,
  base: Draft = EMPTY_DRAFT,
): Draft {
  const values = fillValues(detection)
  const next: Draft = { ...base }

  for (const field of FILLABLE) {
    const value = values[field]
    if (value) next[field] = value as never
  }

  return next
}

/** Which fields a fill would actually change, for telling the user in advance. */
export function fieldsFilled(detection: DetectionSummary, base: Draft): FillableField[] {
  const values = fillValues(detection)

  return FILLABLE.filter((field) => {
    const value = values[field]
    return Boolean(value) && value !== base[field]
  })
}

/**
 * The provenance to store when saving a record that was filled from a page.
 *
 * Kept even if the user then corrects a field by hand. "Which adapter produced
 * this record" stays true of a record that was produced by an adapter and then
 * edited, and it is the question a later parser fix needs answered — a record
 * re-typed from scratch would have arrived through the manual path anyway.
 */
export function saveContextFor(detection: DetectionSummary, draft: Draft): SaveContext {
  const filled = fillValues(detection)

  return {
    source: detection.source,
    sourceConfidence: detection.confidence,
    adapterVersion: detection.adapterVersion,
    // Only while the text still says what the adapter wrote. Once the user has
    // typed over it, the structured range describes something else.
    salary:
      detection.fields.salary && draft.salary.trim() === (filled.salary ?? '').trim()
        ? detection.fields.salary
        : null,
  }
}
