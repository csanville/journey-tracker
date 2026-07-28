/**
 * Join-key derivation, applied to every record on its way into the database.
 *
 * These fields are derived rather than trusted. A caller — the panel today, an
 * extraction adapter in phase 4 — supplies what the page said; the worker
 * decides what the keys are. That is the same single-writer argument as dedupe
 * and schema version (decision 4): a key computed in two places eventually
 * disagrees with itself, and a dedupe key that disagrees with itself is worse
 * than no dedupe at all.
 */
import type { NormalizedPostingInput, PostingInput } from '../types'
import { extractAtsReqId } from './ats'
import { normalizeCompany } from './company'
import { canonicalizeUrl } from './url'

export { identifyAts, extractAtsReqId, type AtsIdentity, type AtsName } from './ats'
export { normalizeCompany } from './company'
export { canonicalizeUrl, isUsableUrlKey } from './url'

/** What a record needs for its join keys to be derivable. */
export interface JoinKeySource {
  company: string
  url: string
  atsReqId: string | null
}

export interface JoinKeys {
  companyNormalized: string
  canonicalUrl: string
  atsReqId: string | null
}

/**
 * The join keys for a record, derived from what the page said.
 *
 * Split out from `normalizePostingInput` so a migration can backfill stored
 * records without constructing a `PostingInput` around each one.
 */
export function deriveJoinKeys(source: JoinKeySource): JoinKeys {
  return {
    companyNormalized: normalizeCompany(source.company),
    canonicalUrl: canonicalizeUrl(source.url),
    atsReqId: source.atsReqId || extractAtsReqId(source.url),
  }
}

/**
 * Fills in `companyNormalized`, `canonicalUrl` and `atsReqId` from what the
 * caller supplied.
 *
 * A caller-supplied `atsReqId` wins: an adapter that read the requisition off
 * the page has better information than a URL pattern. The URL is only the
 * fallback.
 *
 * Idempotent — every underlying normalizer is — so re-normalizing a stored
 * record is safe, which is what makes it usable from a migration.
 */
export function normalizePostingInput(input: PostingInput): NormalizedPostingInput {
  return { ...input, ...deriveJoinKeys(input) }
}
