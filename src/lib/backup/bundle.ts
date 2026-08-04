/**
 * The export file, and the validator that reads one back.
 *
 * JSON is the canonical format and the only one imported (decision 14). The
 * data lives on exactly one device (decision 1), so this file is the entire
 * backup and portability story — it has to round-trip losslessly, which is why
 * the CSV alongside it is a report and never comes back in.
 *
 * Two variants:
 *
 * - **lean** — records only. Small enough to keep in a repo or mail to
 *   yourself, and free of the page-derived PII that snapshots carry from
 *   logged-in sessions (decision 6).
 * - **full** — records plus the trimmed page snapshots, so a restored database
 *   can still be re-parsed after a future adapter fix.
 *
 * Everything here is pure. Reading the database is the repository's job and
 * handing the user a file is the panel's; this module owns what the file *is*.
 */
import { resolveProgress, STAGE_ORDER } from '../normalize/progress'
import { SCHEMA_VERSION } from '../types'
import type {
  Outcome,
  Posting,
  PostingState,
  Salary,
  SalaryPeriod,
  Snapshot,
  Stage,
  WorkMode,
} from '../types'

/** Identifies the file as ours before anything trusts a byte of it. */
export const BUNDLE_FORMAT = 'journeytracker-export'

/**
 * The envelope's own version, which is not `schemaVersion`.
 *
 * `schemaVersion` describes the records inside and moves when a migration
 * ships. This moves only when the envelope around them changes shape. Keeping
 * them apart means an importer can reject a file it cannot open without
 * guessing, and can accept records older than itself without pretending the
 * envelope changed too.
 */
export const BUNDLE_FORMAT_VERSION = 1

export type BundleVariant = 'lean' | 'full'

export interface Bundle {
  format: typeof BUNDLE_FORMAT
  formatVersion: number
  variant: BundleVariant
  /** Epoch milliseconds, for the human reading the file rather than for code. */
  exportedAt: number
  /** The version the records inside are written at. */
  schemaVersion: number
  postings: Posting[]
  /** Always present, always empty in a `lean` bundle. */
  snapshots: Snapshot[]
}

export function buildBundle(
  variant: BundleVariant,
  postings: Posting[],
  snapshots: Snapshot[],
  exportedAt: number,
): Bundle {
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    variant,
    exportedAt,
    schemaVersion: SCHEMA_VERSION,
    postings,
    // Enforced here rather than trusted from the caller: a `lean` file with
    // snapshots in it would carry exactly the PII the variant exists to leave
    // behind, and the mistake would be invisible until someone shared one.
    snapshots: variant === 'full' ? snapshots : [],
  }
}

/**
 * A record the file offered and this build would not take, with the reason.
 *
 * Reported rather than thrown, because a partially corrupt backup should
 * restore the part that is good — but *silently* dropping records from a
 * restore is the worst thing an importer can do, so every one of these reaches
 * the UI as a count the user has to read.
 */
export interface Rejection {
  /** The record's id where it had a usable one, else its position in the file. */
  at: string
  reason: string
}

export interface ParsedBundle {
  bundle: Bundle
  rejected: Rejection[]
}

export type ParseResult = { ok: true; parsed: ParsedBundle } | { ok: false; error: string }

/**
 * Reads an export file back, or explains why it will not.
 *
 * The envelope is all-or-nothing: a file that is not ours, or is a shape this
 * build does not understand, is refused outright rather than half-imported.
 * Individual records are judged one at a time, since one bad record is not a
 * reason to abandon the other four hundred.
 */
export function parseBundle(text: string): ParseResult {
  let raw: unknown

  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `not JSON — ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (!isObject(raw)) return { ok: false, error: 'not a JSON object' }

  if (raw.format !== BUNDLE_FORMAT) {
    return { ok: false, error: 'not a JourneyTracker export file' }
  }

  // Refuses what it cannot open, not what it did not write. An earlier version
  // tested `!==`, which contradicted the reasoning three blocks up: the whole
  // point of versioning the envelope apart from the records is that an importer
  // can take a file older than itself. On the first bump that check would have
  // orphaned every backup already on disk — for a format whose entire purpose
  // is surviving this extension, and with no way to fix it retroactively for a
  // user holding the only copy of their history.
  const formatVersion = raw.formatVersion
  if (typeof formatVersion !== 'number' || formatVersion > BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      error:
        `this export is in format v${String(formatVersion)} and this build reads ` +
        `v${BUNDLE_FORMAT_VERSION}`,
    }
  }

  const schemaVersion = raw.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { ok: false, error: 'the file does not say what schema version it holds' }
  }

  // The same refusal `runPendingMigrations` makes, for the same reason: this
  // build has no idea what a newer record means, and writing one in would let
  // an older shape be stamped over it later. Loading a previous build is an
  // ordinary thing to do here — `Load unpacked` is the whole workflow.
  if (schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      error:
        `this export holds v${schemaVersion} records and this build understands ` +
        `v${SCHEMA_VERSION}. Import it with the newer build.`,
    }
  }

  const variant = raw.variant === 'full' ? 'full' : 'lean'
  const rejected: Rejection[] = []

  const postings = collect(raw.postings, 'posting', validatePosting, rejected)
  const snapshots = collect(raw.snapshots, 'snapshot', validateSnapshot, rejected)

  return {
    ok: true,
    parsed: {
      bundle: {
        format: BUNDLE_FORMAT,
        formatVersion: BUNDLE_FORMAT_VERSION,
        variant,
        exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
        schemaVersion,
        postings,
        snapshots,
      },
      rejected,
    },
  }
}

/** Validates a list item by item, sending the failures to `rejected`. */
function collect<T>(
  raw: unknown,
  what: string,
  validate: (value: unknown) => T | string,
  rejected: Rejection[],
): T[] {
  // A missing list is an empty one — a lean bundle has no snapshots, and a
  // database with nothing in it exports an empty array either way.
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    rejected.push({ at: what, reason: `${what}s is not a list` })
    return []
  }

  const kept: T[] = []

  raw.forEach((value, index) => {
    const result = validate(value)
    if (typeof result === 'string') {
      rejected.push({ at: idOf(value) ?? `${what} ${index + 1}`, reason: result })
      return
    }
    kept.push(result)
  })

  return kept
}

/**
 * Checks a posting field by field, returning the reason on the first problem.
 *
 * Written out rather than reached for with a schema library on purpose: this is
 * the only untrusted input the extension parses that is *meant* to become
 * records, and a dependency whose failure mode is "coerced something silently"
 * is not worth the lines it saves. It also normalizes as it goes — a record
 * with `tags: null` from a hand-edited file is repairable, and repairing it is
 * kinder than rejecting the row.
 */
export function validatePosting(value: unknown): Posting | string {
  if (!isObject(value)) return 'not an object'

  const id = value.id
  if (typeof id !== 'string' || !id.trim()) return 'no id'

  // The two fields the form itself refuses to save without. A record missing
  // either cannot be told apart from any other in a list, which is the one
  // thing a restored backup has to support.
  if (typeof value.company !== 'string' || !value.company.trim()) return 'no company'
  if (typeof value.jobTitle !== 'string' || !value.jobTitle.trim()) return 'no job title'

  const state = value.state === 'applied' ? 'applied' : ('viewed' as PostingState)
  const createdAt = finiteNumber(value.createdAt)
  if (createdAt === null) return 'no created date'

  return {
    id,
    // Capped at what this build understands. The envelope has already been
    // refused if *it* claimed to be newer, so a record claiming more than that
    // is a file somebody edited by hand — and a record stamped above the
    // current version would be read as "written by a newer build" forever
    // after, which is the state `runPendingMigrations` refuses to open at all.
    schemaVersion: Math.min(numberOr(value.schemaVersion, 1), SCHEMA_VERSION),
    createdAt,
    updatedAt: finiteNumber(value.updatedAt) ?? createdAt,

    company: value.company,
    // Derived keys are read but never trusted — the repository re-derives them
    // on the way in, for the same reason it does on every other write
    // (decision 4). Kept here only so a record round-trips through the
    // validator unchanged when nothing needs fixing.
    companyNormalized: stringOr(value.companyNormalized, ''),
    jobTitle: value.jobTitle,
    location: nullableString(value.location),
    workMode: workMode(value.workMode),

    atsReqId: nullableString(value.atsReqId),
    salary: salary(value.salary),

    url: stringOr(value.url, ''),
    canonicalUrl: stringOr(value.canonicalUrl, ''),

    source: stringOr(value.source, 'imported'),
    // Coverage, not a probability (decision 5). Clamped rather than rejected:
    // a nonsense number is not worth losing a record over.
    sourceConfidence: clamp(numberOr(value.sourceConfidence, 0), 0, 1),
    adapterVersion: stringOr(value.adapterVersion, 'imported@1'),

    state,
    // Only meaningful once the application has gone in, which is the same rule
    // the form applies on save.
    appliedAt: state === 'applied' ? finiteNumber(value.appliedAt) : null,
    // Through `resolveProgress` rather than repeated here, so a hand-edited file
    // meets exactly the rules a save does. It is the enforcement point for this
    // path: an import writes records verbatim apart from the join keys
    // (decision 14), so nothing downstream will correct these two.
    ...resolveProgress({
      state,
      stage: stage(value.stage),
      outcome: outcome(value.outcome),
    }),
    resumeUsed: nullableString(value.resumeUsed),
    notes: nullableString(value.notes),
    tags: Array.isArray(value.tags)
      ? value.tags.filter(
          (tag): tag is string => typeof tag === 'string' && tag.trim() !== '',
        )
      : [],
  }
}

export function validateSnapshot(value: unknown): Snapshot | string {
  if (!isObject(value)) return 'not an object'

  const postingId = value.postingId
  if (typeof postingId !== 'string' || !postingId.trim()) return 'no posting id'

  // A snapshot with no source is not a smaller snapshot, it is an empty row in
  // the store that would make a re-parse look possible when it is not.
  const trimmedSource = value.trimmedSource
  if (typeof trimmedSource !== 'string' || trimmedSource === '') return 'no page source'

  return {
    postingId,
    capturedAt: finiteNumber(value.capturedAt) ?? 0,
    adapterVersion: stringOr(value.adapterVersion, 'imported@1'),
    trimmedSource,
    truncated: value.truncated === true,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function idOf(value: unknown): string | null {
  if (!isObject(value)) return null
  const id = typeof value.id === 'string' ? value.id : value.postingId
  return typeof id === 'string' && id.trim() ? id : null
}

/**
 * A real number, or `null`.
 *
 * `Number.isFinite` rather than `typeof === 'number'` because `NaN` and the
 * infinities are what a hand-edited file leaves behind, and `NaN` is the one
 * value that would survive every later check and then poison a sort.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return finiteNumber(value) ?? fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

const WORK_MODES: readonly WorkMode[] = ['onsite', 'hybrid', 'remote']

function workMode(value: unknown): WorkMode | null {
  return WORK_MODES.find((mode) => mode === value) ?? null
}

const OUTCOMES: readonly Outcome[] = ['rejected', 'withdrawn', 'accepted']

function stage(value: unknown): Stage | null {
  return STAGE_ORDER.find((name) => name === value) ?? null
}

function outcome(value: unknown): Outcome | null {
  return OUTCOMES.find((name) => name === value) ?? null
}

const PERIODS: readonly SalaryPeriod[] = ['hour', 'day', 'week', 'month', 'year']

/**
 * A salary is kept only when something in it survives.
 *
 * An object of five nulls is indistinguishable from no salary at all and would
 * make `salary !== null` a lie to every caller that checks it.
 */
function salary(value: unknown): Salary | null {
  if (!isObject(value)) return null

  const parsed: Salary = {
    min: finiteNumber(value.min),
    max: finiteNumber(value.max),
    currency: nullableString(value.currency),
    period: PERIODS.find((period) => period === value.period) ?? null,
    raw: nullableString(value.raw),
  }

  return Object.values(parsed).some((field) => field !== null) ? parsed : null
}
