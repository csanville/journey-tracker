import type { WorkMode } from '../types'
import { cleanText } from './text'

/**
 * Work mode, inferred only from fields that are *about* where the work happens.
 *
 * The input to this is always a location string or a board's own workplace-type
 * label — never the job title, and never the description. "Remote Sensing
 * Engineer" is a real job, "Hybrid Systems Researcher" is a real job, and a
 * description that says "we are not a remote-first company" contains the word
 * remote. Widening the haystack is how this field starts lying, and decision 7's
 * lesson from the normalization layer applies unchanged: the traps are all
 * ordinary words.
 */

/** Word-boundary anchored, so `Bremerton` and `remotely` do not both count. */
const PATTERNS: readonly [RegExp, WorkMode][] = [
  [/\bremote\b/i, 'remote'],
  [/\bwork from home\b/i, 'remote'],
  [/\btelecommute\b/i, 'remote'],
  [/\bhybrid\b/i, 'hybrid'],
  [/\bon-?site\b/i, 'onsite'],
  [/\bin-?office\b/i, 'onsite'],
  [/\bin-?person\b/i, 'onsite'],
]

/**
 * Reads a work mode out of a location or workplace-type string.
 *
 * Hybrid wins over remote when both appear, which is the case that actually
 * shows up: "Hybrid — 2 days remote" is a hybrid role describing itself, and
 * "Remote or hybrid" is a role that will take either. Calling both of those
 * hybrid is right more often than calling them remote, and neither is a silent
 * merge — it is one dropdown the user can change.
 */
export function inferWorkMode(...values: (string | null | undefined)[]): WorkMode | null {
  const haystack = values
    .map((value) => cleanText(value))
    .filter((value): value is string => value !== null)
    .join(' | ')

  if (!haystack) return null

  const found = new Set<WorkMode>()
  for (const [pattern, mode] of PATTERNS) {
    if (pattern.test(haystack)) found.add(mode)
  }

  if (found.has('hybrid')) return 'hybrid'
  if (found.has('remote')) return 'remote'
  if (found.has('onsite')) return 'onsite'

  return null
}

/**
 * schema.org's own answer, which is authoritative where it exists.
 *
 * `jobLocationType` has exactly one defined value — `TELECOMMUTE` — so this is
 * a yes-or-nothing signal rather than a mapping. There is no schema.org term for
 * hybrid or onsite, which is why the string sniffing above still has to exist.
 */
export function workModeFromLocationType(value: unknown): WorkMode | null {
  const text = cleanText(typeof value === 'string' ? value : null)

  return text && /telecommute/i.test(text) ? 'remote' : null
}
