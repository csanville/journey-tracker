/**
 * The form's state, kept as plain data with plain functions over it.
 *
 * Everything here is deliberately outside React. The parts of a form worth
 * getting right — what counts as dirty, what an empty field means, what shape
 * reaches the database — are the parts that are awkward to test through a
 * component and easy to test as functions.
 *
 * A draft is all strings because that is what inputs hold. Converting to the
 * stored shape happens once, at save.
 */
import { newId } from '../lib/ids'
import { resolveProgress } from '../lib/normalize/progress'
import type {
  Outcome,
  PostingInput,
  PostingState,
  Salary,
  Stage,
  WorkMode,
} from '../lib/types'

export interface Draft {
  company: string
  jobTitle: string
  location: string
  workMode: WorkMode | ''
  atsReqId: string
  salary: string
  url: string
  state: PostingState
  /** `YYYY-MM-DD` from a date input, or empty. */
  appliedAt: string
  /** Empty is "nothing heard", which is the ordinary state, not a missing answer. */
  stage: Stage | ''
  /** Empty is "still open". */
  outcome: Outcome | ''
  resumeUsed: string
  notes: string
  /** Comma-separated as typed. */
  tags: string
}

export const EMPTY_DRAFT: Draft = {
  company: '',
  jobTitle: '',
  location: '',
  workMode: '',
  atsReqId: '',
  salary: '',
  url: '',
  state: 'viewed',
  appliedAt: '',
  stage: '',
  outcome: '',
  resumeUsed: '',
  notes: '',
  tags: '',
}

export const DRAFT_FIELDS = Object.keys(EMPTY_DRAFT) as (keyof Draft)[]

/**
 * Whether the user has touched anything.
 *
 * Compared against a baseline rather than against empty, because from phase 5 a
 * pristine form is one that still matches what was auto-filled into it, not one
 * that is blank (decision 13). Whitespace-only edits do not count — someone who
 * tabbed through the form has not written anything worth protecting.
 */
export function isDirty(draft: Draft, baseline: Draft = EMPTY_DRAFT): boolean {
  return DRAFT_FIELDS.some((field) => draft[field].trim() !== baseline[field].trim())
}

export interface DraftErrors {
  company?: string
  jobTitle?: string
}

/**
 * Only the two fields without which a record cannot be identified later.
 *
 * The URL is not required: a job heard about by email or seen on a
 * screen-shared listing is still worth tracking, and `findDuplicate` already
 * declines to key on a URL that is not one. Everything else is genuinely
 * optional — a form that refuses to save half-known information is a form
 * people work around.
 */
export function draftErrors(draft: Draft): DraftErrors {
  const errors: DraftErrors = {}

  if (!draft.company.trim()) errors.company = 'Company is needed to file this anywhere.'
  if (!draft.jobTitle.trim()) errors.jobTitle = 'Job title is needed to tell roles apart.'

  return errors
}

export function isSaveable(draft: Draft): boolean {
  return Object.keys(draftErrors(draft)).length === 0
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Splits on commas, drops blanks and duplicates, preserves the order typed. */
export function parseTags(value: string): string[] {
  const seen = new Set<string>()

  for (const tag of value.split(',')) {
    const trimmed = tag.trim()
    if (trimmed) seen.add(trimmed)
  }

  return [...seen]
}

/**
 * `YYYY-MM-DD` as epoch milliseconds at local midnight.
 *
 * Local rather than UTC on purpose: the user picked a calendar date in their own
 * timezone, and parsing it as UTC would shift it a day backwards for anyone west
 * of Greenwich.
 */
export function parseAppliedAt(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null

  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))

  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

/**
 * Where a record's contents came from, written onto it at save.
 *
 * `source` and `adapterVersion` are what make a stored snapshot re-parseable
 * later (decision 6): they say which parser produced this record, so a fix to
 * that parser knows which records to replay. A hand-typed record is still an
 * answer to that question — `manual@1` — which is why the default is a value
 * rather than an absence.
 */
export interface SaveContext {
  source: string
  sourceConfidence: number
  adapterVersion: string
  /**
   * A structured salary from an adapter, used in place of the raw text.
   *
   * Only passed when the adapter parsed one *and* the user has not edited the
   * salary field since. The form is all strings, so a range with a currency and
   * a period cannot survive a round trip through it; carrying it alongside is
   * what keeps `min`/`max`/`period` from being thrown away the moment they are
   * shown to somebody.
   */
  salary?: Salary | null
}

export const MANUAL_SAVE: SaveContext = {
  source: 'manual',
  sourceConfidence: 1,
  adapterVersion: 'manual@1',
}

/**
 * Converts a draft into what the repository stores.
 *
 * `companyNormalized` and `canonicalUrl` are absent by design — the worker
 * derives them, and a form that guessed at them would be a second place for the
 * join keys to disagree.
 *
 * A typed salary is kept as raw text. Splitting a phrase like "$120k–150k, DOE"
 * into a range is parsing, and the extraction layer deliberately does not do it
 * either — see `lib/extract/salary.ts`, which reads structured salary only where
 * a board states it structurally. Where it did, `context.salary` carries the
 * result and this uses it.
 */
export function toPostingInput(
  draft: Draft,
  id: string = newId(),
  context: SaveContext = MANUAL_SAVE,
): PostingInput {
  const typed = blankToNull(draft.salary)

  return {
    id,
    company: draft.company.trim(),
    jobTitle: draft.jobTitle.trim(),
    location: blankToNull(draft.location),
    workMode: draft.workMode || null,
    atsReqId: blankToNull(draft.atsReqId),
    salary:
      context.salary ??
      (typed ? { min: null, max: null, currency: null, period: null, raw: typed } : null),
    url: draft.url.trim(),
    source: context.source,
    sourceConfidence: context.sourceConfidence,
    adapterVersion: context.adapterVersion,
    state: draft.state,
    // A date only means anything once the application has actually gone in.
    appliedAt: draft.state === 'applied' ? parseAppliedAt(draft.appliedAt) : null,
    // Same rule, through the shared resolver rather than repeated: what happened
    // after an application is meaningless on a posting only looked at. The
    // repository applies this again on the way in, which is where it binds
    // (decision 4) — doing it here as well keeps what the panel shows and what
    // gets stored from disagreeing in the moment before the round trip.
    ...resolveProgress({
      state: draft.state,
      stage: draft.stage || null,
      outcome: draft.outcome || null,
    }),
    resumeUsed: blankToNull(draft.resumeUsed),
    notes: blankToNull(draft.notes),
    tags: parseTags(draft.tags),
  }
}

/** Today as `YYYY-MM-DD` in the local timezone, for defaulting the date field. */
export function today(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')

  return `${now.getFullYear()}-${month}-${day}`
}
