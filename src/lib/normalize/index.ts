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
import type { PostingInput } from '../types'
import { extractAtsReqId } from './ats'
import { normalizeCompany } from './company'
import { canonicalizeUrl } from './url'

export { identifyAts, extractAtsReqId, type AtsIdentity, type AtsName } from './ats'
export { normalizeCompany } from './company'
export { canonicalizeUrl } from './url'

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
export function normalizePostingInput(input: PostingInput): PostingInput {
  return {
    ...input,
    companyNormalized: normalizeCompany(input.company),
    canonicalUrl: canonicalizeUrl(input.url),
    atsReqId: input.atsReqId || extractAtsReqId(input.url),
  }
}
