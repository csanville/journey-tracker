/**
 * Job title folding, for the weakest of the three dedupe keys.
 *
 * This exists for one purpose: recognising that "Senior Software Engineer" and
 * "Senior Software Engineer " and "Senior Software Engineer" with a non-breaking
 * space are the same words. It is not trying to understand job titles.
 *
 * Deliberately shallow. It does not touch seniority ("Senior" is not noise), it
 * does not strip parentheticals ("(Remote)" and "(Hybrid)" tell postings apart),
 * and it does not normalize levels ("Engineer II" stays distinct from "Engineer
 * III"). Everything it declines to do is a case where two postings would look
 * identical and not be.
 *
 * The output is never stored — it is computed over the handful of candidates at
 * one employer, so it can change without a migration.
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
