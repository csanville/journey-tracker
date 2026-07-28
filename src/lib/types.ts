/**
 * The stored record shape.
 *
 * `schemaVersion` is written onto every record from the very first version so
 * migrations and cross-version imports stay possible (decision 10). Bump it in
 * lockstep with adding a migration to `migrations.ts` — never on its own.
 */
export const SCHEMA_VERSION = 1

/**
 * Whether the user merely looked at a posting or actually applied to it.
 *
 * These are deliberately not one field with an `applied` boolean bolted on:
 * `applied` is never inferred from `viewed`, because response rate and funnel
 * conversion are unreconstructable if the distinction is lost (decision 8).
 */
export type PostingState = 'viewed' | 'applied'

export type WorkMode = 'onsite' | 'hybrid' | 'remote'

export type SalaryPeriod = 'hour' | 'day' | 'week' | 'month' | 'year'

export interface Salary {
  min: number | null
  max: number | null
  currency: string | null
  period: SalaryPeriod | null
  /** Exactly as the page phrased it, kept so a parsing bug stays diagnosable. */
  raw: string | null
}

export interface Posting {
  id: string
  schemaVersion: number
  createdAt: number
  updatedAt: number

  company: string
  /** Dedupe key, derived by `normalizeCompany`. Never set by the caller. */
  companyNormalized: string
  jobTitle: string
  location: string | null
  workMode: WorkMode | null

  atsReqId: string | null
  salary: Salary | null

  url: string
  /** Dedupe key, derived by `canonicalizeUrl`. Never set by the caller. */
  canonicalUrl: string

  /** Adapter that produced this record: `manual`, `jsonld`, `greenhouse`, … */
  source: string
  /** 0–1. Partial extractions are expected, so callers can weigh what they got. */
  sourceConfidence: number
  /** Which version of that adapter, so a snapshot can be re-parsed knowingly. */
  adapterVersion: string

  state: PostingState
  appliedAt: number | null
  /** A label, never a file. The extension stores no resumes (decision 11). */
  resumeUsed: string | null
  notes: string | null
  tags: string[]
}

/**
 * The raw source a record was parsed from, kept in its own store because it is
 * orders of magnitude larger than the record and is read only when re-parsing
 * or debugging (decisions 3 and 6).
 */
export interface Snapshot {
  postingId: string
  capturedAt: number
  adapterVersion: string
  trimmedSource: string
  /** True when the source hit the size cap and was cut short. */
  truncated: boolean
}

/**
 * What a caller supplies to write a posting. `id` is required rather than
 * generated server-side: a caller-owned id is what makes a retried write
 * idempotent when the service worker dies mid-request (decision 4).
 */
export type PostingInput = Omit<Posting, 'schemaVersion' | 'createdAt' | 'updatedAt'> & {
  createdAt?: number
}

/** Fields a caller controls; the rest are managed by the repository. */
export const POSTING_INPUT_FIELDS = [
  'company',
  'companyNormalized',
  'jobTitle',
  'location',
  'workMode',
  'atsReqId',
  'salary',
  'url',
  'canonicalUrl',
  'source',
  'sourceConfidence',
  'adapterVersion',
  'state',
  'appliedAt',
  'resumeUsed',
  'notes',
  'tags',
] as const satisfies readonly (keyof PostingInput)[]
