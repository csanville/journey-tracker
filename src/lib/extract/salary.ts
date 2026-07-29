import type { Salary, SalaryPeriod } from '../types'
import { cleanText } from './text'

/**
 * Salary, read from schema.org `baseSalary` and nowhere else.
 *
 * This is a deliberate scope line. Structured salary is parsed only where a
 * board states it structurally; salary written in prose — "The OTE range for
 * this full-time position is $272,000 to $306,000 + equity + benefits", which is
 * how the real Greenhouse capture in the fixtures phrases it — is left as raw
 * text for the user to keep or edit.
 *
 * The reason is the same asymmetry that governs the join keys (decision 7),
 * pointed at a different field. A missed salary costs the user a copy-paste. A
 * *wrong* salary is a number that looks authoritative in a dashboard and is off
 * by a factor of twelve because the page said "per month", or reads an equity
 * figure as base pay. Prose ranges are where every one of those mistakes lives,
 * so this module does not go there.
 */

const PERIODS: Record<string, SalaryPeriod> = {
  HOUR: 'hour',
  HOURLY: 'hour',
  DAY: 'day',
  DAILY: 'day',
  WEEK: 'week',
  WEEKLY: 'week',
  MONTH: 'month',
  MONTHLY: 'month',
  YEAR: 'year',
  YEARLY: 'year',
  ANNUAL: 'year',
}

/** A salary above this is a units mistake, not a job offer. */
const IMPLAUSIBLE = 100_000_000

function toPeriod(value: unknown): SalaryPeriod | null {
  const text = cleanText(typeof value === 'string' ? value : null)
  return text ? (PERIODS[text.toUpperCase()] ?? null) : null
}

/**
 * A number, but only when the page really gave one.
 *
 * Numeric strings are accepted because boards emit `"120000"` as often as
 * `120000`, but a string that is not wholly a number is rejected rather than
 * coerced: `Number('120k')` is `NaN` and `Number('')` is `0`, and a salary of
 * zero written into a record reads as a real figure forever.
 */
function toAmount(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN

  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > IMPLAUSIBLE) return null

  return numeric
}

function currencyOf(value: unknown): string | null {
  const text = cleanText(typeof value === 'string' ? value : null)

  // ISO 4217 is three letters. Anything else — a `$` glyph, a sentence — is not
  // a currency code, and storing one would make two records incomparable.
  return text && /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : null
}

type Unknowns = Record<string, unknown>

function asObject(value: unknown): Unknowns | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Unknowns)
    : null
}

/**
 * Renders the parsed figures back into the sentence the form shows.
 *
 * `Salary.raw` is documented as "exactly as the page phrased it", and for a
 * JSON-LD source the page phrased it as a JSON object — useless in a text
 * input. Diagnosability is not lost by rendering instead: the snapshot keeps the
 * JSON-LD block verbatim (decision 6), so the original is exactly one lookup
 * away, which is what snapshots are for.
 */
function render(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: SalaryPeriod | null,
): string {
  const money = (amount: number) =>
    `${currency ? `${currency} ` : ''}${amount.toLocaleString('en-US')}`

  // An open-ended range says so. "up to 200,000" and "200,000" are different
  // claims, and the string is what the user reads in the form before saving.
  const range =
    min !== null && max !== null
      ? min === max
        ? money(min)
        : `${money(min)}–${money(max)}`
      : min !== null
        ? `from ${money(min)}`
        : `up to ${money(max as number)}`

  return period ? `${range} per ${period}` : range
}

/**
 * Reads a schema.org `baseSalary` into the stored `Salary` shape, or `null`.
 *
 * Tolerates the three shapes boards actually emit: a `MonetaryAmount` wrapping a
 * `QuantitativeValue` with `minValue`/`maxValue`, the same with a single
 * `value`, and a bare number. Anything else yields `null` — an unrecognised
 * shape is not worth a guess.
 */
export function parseBaseSalary(raw: unknown): Salary | null {
  const bare = toAmount(raw)
  if (bare !== null) {
    return {
      min: bare,
      max: bare,
      currency: null,
      period: null,
      raw: render(bare, bare, null, null),
    }
  }

  const amount = asObject(raw)
  if (!amount) return null

  const currency = currencyOf(amount.currency ?? amount.currencyCode)
  const inner = asObject(amount.value)

  const single = toAmount(inner ? inner.value : amount.value)
  const min = toAmount(inner?.minValue) ?? single
  const max = toAmount(inner?.maxValue) ?? single

  if (min === null && max === null) return null

  const period = toPeriod(inner?.unitText ?? amount.unitText)

  // A range whose ends arrived backwards is a page bug, not a signal; ordering
  // them here keeps every downstream comparison honest.
  //
  // An end that is *absent* is left absent. A posting that states only a
  // maximum is saying "up to 200,000", and mirroring that figure into `min`
  // would record a floor the employer never offered — an invented number that
  // reads as authoritative in every later aggregation, which is the exact
  // failure this module's preamble refuses to risk. A one-sided range is
  // honest; a fabricated two-sided one is not.
  const ordered = min !== null && max !== null
  const low = ordered ? Math.min(min, max) : min
  const high = ordered ? Math.max(min, max) : max

  return { min: low, max: high, currency, period, raw: render(low, high, currency, period) }
}
