import type { Salary, WorkMode } from '../types'

/**
 * Where a field came from, which is the same thing as how much to trust it.
 *
 * The order here is the order they are consulted, and it is **not** the order
 * the roadmap originally specified. That put OpenGraph second, straight after
 * JSON-LD. Reading the real markup of both launch boards showed why that is
 * wrong:
 *
 * - Lever's `og:title` is `"Lever Demo 2 - Software Engineer"` — company and
 *   title welded together — while its DOM has the title alone in
 *   `.posting-headline h2`.
 * - Greenhouse's `og:description` is not a description at all. It holds the
 *   location string.
 *
 * OpenGraph is social-preview copy. It is written to read well in a link
 * unfurl, not to name a field, so a board is free to put anything in it. Site
 * knowledge — the board's own state blob, or a selector aimed at the board's own
 * markup — beats it every time. Meta stays in the list because it is the only
 * tier that works on a site nobody has written an adapter for, which is what
 * makes the generic adapter worth having (decision 5); it just belongs last.
 */
export type Tier = 'jsonld' | 'appstate' | 'dom' | 'meta'

/** Consulted in this order; the first tier to supply a field wins it. */
export const TIER_ORDER: readonly Tier[] = ['jsonld', 'appstate', 'dom', 'meta']

/**
 * What a page can tell us about a posting.
 *
 * Every field is nullable because partial extraction is the normal case, not a
 * failure (decision 5). A tier that finds two of six fields has still saved the
 * user two fields of typing.
 *
 * Deliberately absent: `url`. The URL is not extracted, it is reported — by the
 * content script, from its own `location.href` (decision 2) — and `atsReqId` is
 * then derived from it by the existing normalization layer. An adapter only
 * fills `atsReqId` when the *page* states a requisition the URL does not carry.
 */
export interface ExtractedFields {
  company: string | null
  jobTitle: string | null
  location: string | null
  workMode: WorkMode | null
  atsReqId: string | null
  salary: Salary | null
}

export type FieldName = keyof ExtractedFields

export const FIELD_NAMES = [
  'company',
  'jobTitle',
  'location',
  'workMode',
  'atsReqId',
  'salary',
] as const satisfies readonly FieldName[]

export const EMPTY_FIELDS: ExtractedFields = {
  company: null,
  jobTitle: null,
  location: null,
  workMode: null,
  atsReqId: null,
  salary: null,
}

/** One tier's answer. Absent keys mean "this tier had nothing to say". */
export interface TierResult {
  tier: Tier
  fields: Partial<ExtractedFields>
}

/**
 * A tier reads a parsed document and reports what it found.
 *
 * A `Document` rather than an HTML string because that is what a content script
 * already has, and because re-serializing to re-parse would be the one place a
 * page's markup could be mangled before anyone looked at it.
 */
export type TierReader = (document: Document) => Partial<ExtractedFields>

export interface Adapter {
  /** Stored on the record as `source`. */
  name: string
  /** Bumped whenever this adapter's output could change, so a stored snapshot
   *  can be re-parsed knowing what produced the record it is attached to
   *  (decision 6). */
  version: number
  /** Whether this adapter handles the page at `url`. */
  matches: (url: URL) => boolean
  /** Ordered readers. The registry sorts their output by `TIER_ORDER`. */
  readers: readonly { tier: Tier; read: TierReader }[]
}

/** What an adapter run produces, before anything is written anywhere. */
export interface Extraction {
  fields: ExtractedFields
  /** Which tier supplied each field, or `null` where nothing did. */
  provenance: Record<FieldName, Tier | null>
  /** The adapter's name, stored on the record as `source`. */
  source: string
  /** `name@version`, matching the `manual@1` the form already writes. */
  adapterVersion: string
  /** 0–1, weighted by which tier answered. See `scoreConfidence`. */
  confidence: number
}
