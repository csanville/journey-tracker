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
 * What a newly detected posting should do to the form.
 *
 * Decision 13 as a function, kept out of the component for the same reason the
 * rest of this file is: the rule is the part worth getting right, and a rule
 * expressed as four interacting `if`s inside an effect is a rule nobody can
 * check. The component supplies the state and does as it is told.
 *
 * - `fill` — the form is pristine, so the new posting simply becomes the form.
 *   Pristine means *untouched*, not *empty*: a form auto-filled from the last
 *   posting and left alone is still pristine, and that is exactly the case that
 *   must swap, because it is what tabbing between two postings looks like.
 * - `announce` — the form is holding something the user has not finished with,
 *   so the posting waits in a banner. Losing typed notes by tabbing away to
 *   check something is the small betrayal decision 13 exists to prevent, and an
 *   unanswered question is the same betrayal in a different shape.
 * - `nothing` — either there is no new posting, or a save is in flight, or the
 *   user already folded this one away. A save in flight matters more than it
 *   looks: the draft has already been snapshotted for writing, so a fill landing
 *   in the gap is saved as the pre-fill values and then wiped by the reset.
 */
export type SwapAction = 'fill' | 'announce' | 'nothing'

export function swapAction(state: {
  /** Whether there is a detection not already in the form. */
  offered: boolean
  /** Whether the user has typed anything worth protecting. */
  dirty: boolean
  /** Whether a save is in flight. */
  busy: boolean
  /**
   * Whether the form is waiting on an answer — the duplicate prompt, or a save
   * that failed.
   *
   * Separate from `busy` because nothing is in flight during either: `busy`
   * protects a draft that has already been snapshotted for writing, and this
   * protects a *question*. Without it, any re-report — and `watch-url.ts` polls
   * every second, so a tracking parameter appended by the page is enough —
   * refills the form and resets the phase, and "You already saved this one:
   * Discard / Save anyway" vanishes with the draft it was asking about. The user
   * answered nothing and something happened anyway.
   */
  prompting: boolean
  /** Whether this particular detection's banner was folded away. */
  dismissed: boolean
}): SwapAction {
  if (!state.offered || state.busy) return 'nothing'
  if (state.dirty || state.prompting) return 'announce'

  return state.dismissed ? 'nothing' : 'fill'
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
