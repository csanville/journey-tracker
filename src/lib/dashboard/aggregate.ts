/**
 * The dashboard's arithmetic, kept away from the rendering.
 *
 * Phase 6's review found fifteen defects and almost none of them were in the
 * storage layer — they were in what the code *said* about what it had done: a
 * count that promised more than the database held, a summary that under-reported
 * a partial import, a dialog offering to erase zero records over a full store.
 * The dashboard is nothing but claims about the record set, so it is the same
 * hazard with a larger surface.
 *
 * The rule this file follows, everywhere: **every record is either counted in a
 * visible bucket or counted in a named residual.** A record that fits nowhere is
 * never dropped quietly, because a chart that silently omits records is a chart
 * that disagrees with the funnel beside it and gives no way to tell which one
 * lied. `appliedWithoutDate` and `beforeWindow` exist for exactly that reason;
 * both are usually zero and both have to be reported when they are not.
 *
 * Rates are `null` rather than `0` when there is nothing to divide. Zero percent
 * is a finding — it says you applied to nothing — and an empty database has not
 * earned the right to say it.
 */

import type { Outcome, Posting, PostingState } from '../types'
import { heardBack, stageAtLeast } from '../normalize/progress'
import { urlHost } from '../normalize/url'

/** How the two states divide the record set. */
export interface Funnel {
  /** Every record, whatever its state. */
  tracked: number
  viewed: number
  applied: number
  /**
   * `applied / tracked`, or `null` when nothing is tracked.
   *
   * Deliberately not a percentage string: formatting is the view's business,
   * and a caller that wants one decimal place should not have to re-parse this.
   */
  appliedRate: number | null
}

export function funnel(postings: readonly Posting[]): Funnel {
  let viewed = 0
  let applied = 0

  for (const posting of postings) {
    if (posting.state === 'applied') applied++
    else viewed++
  }

  const tracked = postings.length

  return {
    tracked,
    viewed,
    applied,
    appliedRate: tracked === 0 ? null : applied / tracked,
  }
}

/**
 * What the employer did, for the applications that were actually sent.
 *
 * Every count here is out of `applied` — the same number `funnel` reports — so
 * the three rates are comparable with each other and with the view above them.
 * Dividing the later stages by the earlier ones would answer a different and
 * narrower question ("of those who replied, how many interviewed"), and mixing
 * the two denominators in one funnel is how a chart ends up disagreeing with
 * itself.
 *
 * `interviewed` and `offers` are cumulative rather than exclusive, because
 * `stage` is the *furthest* point reached: an offer was interviewed for. That is
 * what makes this a funnel — each row is a subset of the one above it, and the
 * counts fall monotonically by construction rather than by luck.
 */
export interface ResponseFunnel {
  applied: number
  /** Applications that got any answer at all. A rejection counts. */
  heardBack: number
  interviewed: number
  offers: number
  /** All out of `applied`, and `null` when nothing has been applied to. */
  responseRate: number | null
  interviewRate: number | null
  offerRate: number | null
}

export function responseFunnel(postings: readonly Posting[]): ResponseFunnel {
  let applied = 0
  let answered = 0
  let interviewed = 0
  let offers = 0

  for (const posting of postings) {
    if (posting.state !== 'applied') continue

    applied++
    if (heardBack(posting)) answered++
    if (stageAtLeast(posting.stage, 'interviewing')) interviewed++
    if (stageAtLeast(posting.stage, 'offer')) offers++
  }

  const rate = (count: number) => (applied === 0 ? null : count / applied)

  return {
    applied,
    heardBack: answered,
    interviewed,
    offers,
    responseRate: rate(answered),
    interviewRate: rate(interviewed),
    offerRate: rate(offers),
  }
}

/**
 * How the applications ended, or that they have not.
 *
 * Exactly one bucket per applied record — `open + rejected + withdrawn +
 * accepted === applied` — which is this file's rule stated as arithmetic. There
 * is no residual because there is nowhere for a record to fall: `outcome` is
 * either null or one of three values, and the repository guarantees it.
 */
export interface Outcomes {
  applied: number
  /** Still live: no outcome recorded. The ordinary state of a recent send. */
  open: number
  rejected: number
  withdrawn: number
  accepted: number
}

export function outcomes(postings: readonly Posting[]): Outcomes {
  const counts: Record<Outcome, number> = { rejected: 0, withdrawn: 0, accepted: 0 }
  let applied = 0
  let open = 0

  for (const posting of postings) {
    if (posting.state !== 'applied') continue

    applied++
    if (posting.outcome === null) open++
    else counts[posting.outcome]++
  }

  return { applied, open, ...counts }
}

/** Three weeks with no reply is the point at which silence is the answer. */
export const SILENCE_THRESHOLD_DAYS = 21

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The applications still open that nobody has ever answered.
 *
 * The one view in this file that needed no new field — it is `appliedAt` and
 * the absence of everything else. That is deliberate: "no response" is not
 * stored as a value precisely so that this number cannot go stale (see `Stage`
 * in `types.ts`).
 *
 * `waiting + recent + undateable === unanswered`, and the three are exclusive.
 * Records that heard back, and records already closed, are not in this view at
 * all — they are not waiting for anything.
 */
export interface Silence {
  /** Applied, never answered, still open. The total the three below divide. */
  unanswered: number
  /** Unanswered for at least `thresholdDays`. */
  waiting: number
  /** Unanswered but too recent to read anything into. */
  recent: number
  /**
   * Unanswered with no `appliedAt`, so it cannot be aged.
   *
   * The same residual `overTime` carries as `appliedWithoutDate` and for the
   * same reason: the date and the status are two different controls, and the
   * importer takes records written by any earlier build. Dropping these
   * silently would make `waiting + recent` disagree with `unanswered` with no
   * way to tell which was wrong.
   */
  undateable: number
  thresholdDays: number
  /** Days since the oldest unanswered application, or `null` if there are none. */
  longestWaitDays: number | null
}

export interface SilenceOptions {
  thresholdDays?: number
  now?: number
}

export function silence(
  postings: readonly Posting[],
  { thresholdDays = SILENCE_THRESHOLD_DAYS, now = Date.now() }: SilenceOptions = {},
): Silence {
  let unanswered = 0
  let waiting = 0
  let recent = 0
  let undateable = 0
  let oldest: number | null = null

  for (const posting of postings) {
    // Closed is not waiting, and an answer already arrived is not silence.
    if (posting.state !== 'applied') continue
    if (posting.outcome !== null || heardBack(posting)) continue

    unanswered++

    if (posting.appliedAt === null) {
      undateable++
      continue
    }

    // Clamped at zero so a hand-typed future date reads as "sent today" rather
    // than as a negative wait, which would drag `longestWaitDays` below zero.
    const days = Math.max(0, Math.floor((now - posting.appliedAt) / DAY_MS))
    if (days >= thresholdDays) waiting++
    else recent++

    if (oldest === null || days > oldest) oldest = days
  }

  return { unanswered, waiting, recent, undateable, thresholdDays, longestWaitDays: oldest }
}

export type BucketSize = 'week' | 'month'

export interface TimeBucket {
  /** Local midnight at the start of the bucket. */
  start: number
  /** Records first tracked in this bucket, by `createdAt`. */
  tracked: number
  /** Applications sent in this bucket, by `appliedAt`. */
  applied: number
}

export interface OverTime {
  size: BucketSize
  /** Oldest first, gap-free — an empty week is a zero, never a missing column. */
  buckets: TimeBucket[]
  /**
   * Applied records carrying no `appliedAt`.
   *
   * Not a defensive nicety: `state` and `appliedAt` are set by two different
   * controls on the form, `PostingForm.tsx` guards for exactly this pair, and
   * the importer accepts records written by any earlier build. Such a record is
   * in the funnel's `applied` and cannot be placed on a timeline, so leaving it
   * out silently would make this chart quietly disagree with the funnel.
   */
  appliedWithoutDate: number
  /**
   * Records whose dates fall before the oldest bucket shown.
   *
   * The window is capped so a two-year history does not render a hundred
   * columns three pixels wide. Whatever the cap excludes is counted here.
   */
  beforeWindow: { tracked: number; applied: number }
}

export interface OverTimeOptions {
  size?: BucketSize
  /** How many buckets to show, ending with the one containing `now`. */
  limit?: number
  now?: number
}

/**
 * Tracking and applying over time, in gap-free buckets ending at today.
 *
 * Two series rather than one because they answer different questions and move
 * independently: a week of heavy browsing and no applications looks identical to
 * a quiet week if only one line is drawn.
 */
export function overTime(
  postings: readonly Posting[],
  { size = 'week', limit = 12, now = Date.now() }: OverTimeOptions = {},
): OverTime {
  const startOf = size === 'week' ? startOfWeek : startOfMonth
  const buckets: TimeBucket[] = []

  // Walk back from the current bucket so the window always ends at today, even
  // when the newest record is old. "Nothing for six weeks" is a finding, and a
  // chart that ends at the last record hides it.
  const newest: TimeBucket = { start: startOf(now), tracked: 0, applied: 0 }
  buckets.push(newest)

  let cursor = newest.start
  for (let i = 1; i < Math.max(1, limit); i++) {
    cursor = startOf(previous(cursor, size))
    buckets.unshift({ start: cursor, tracked: 0, applied: 0 })
  }

  const windowStart = cursor
  const index = new Map<number, TimeBucket>(buckets.map((b) => [b.start, b]))
  const beforeWindow = { tracked: 0, applied: 0 }
  let appliedWithoutDate = 0

  const place = (timestamp: number, field: 'tracked' | 'applied') => {
    if (timestamp < windowStart) {
      beforeWindow[field]++
      return
    }
    // A record dated in the future — a hand-typed applied date, most likely —
    // belongs to the newest bucket rather than to none of them.
    const bucket = index.get(startOf(timestamp)) ?? newest
    bucket[field]++
  }

  for (const posting of postings) {
    place(posting.createdAt, 'tracked')

    if (posting.state !== 'applied') continue

    if (posting.appliedAt === null) appliedWithoutDate++
    else place(posting.appliedAt, 'applied')
  }

  return { size, buckets, appliedWithoutDate, beforeWindow }
}

export interface BoardYield {
  /** Display label — a known board's name, or the bare host. */
  board: string
  tracked: number
  applied: number
  /** `applied / tracked`. Never `null` here: a row exists only if it has records. */
  appliedRate: number
}

export interface PerBoard {
  rows: BoardYield[]
  /**
   * Records with no usable URL to attribute — hand-entered ones, mostly.
   *
   * Its own field rather than a row, because it is not a board and sorting it
   * among them would invite reading it as one.
   */
  unattributed: { tracked: number; applied: number }
}

/**
 * Known boards, longest-suffix-first so a company's own Greenhouse subdomain
 * resolves to Greenhouse rather than to itself.
 *
 * Grouping is by *host* rather than by `identifyAts`, which needs a parseable
 * requisition id and returns `null` without one — a Greenhouse URL this cannot
 * pull a req id from is still unambiguously Greenhouse, and putting it in its
 * own row would split one board across two lines. Grouping by the record's
 * `source` was the other option and is worse: it names the adapter that read the
 * page, so the same board splits by capture method.
 */
const BOARDS: ReadonlyArray<{ suffix: string; label: string }> = [
  { suffix: 'greenhouse.io', label: 'Greenhouse' },
  { suffix: 'lever.co', label: 'Lever' },
  { suffix: 'ashbyhq.com', label: 'Ashby' },
  { suffix: 'myworkdayjobs.com', label: 'Workday' },
  { suffix: 'icims.com', label: 'iCIMS' },
  { suffix: 'smartrecruiters.com', label: 'SmartRecruiters' },
  { suffix: 'linkedin.com', label: 'LinkedIn' },
  { suffix: 'indeed.com', label: 'Indeed' },
]

/** The board label for a canonical URL, or `null` when there is no host to use. */
export function boardOf(canonicalUrl: string): string | null {
  const host = urlHost(canonicalUrl)
  if (host === null) return null

  const lower = host.toLowerCase()
  for (const { suffix, label } of BOARDS) {
    if (lower === suffix || lower.endsWith(`.${suffix}`)) return label
  }

  return lower.replace(/^www\./, '')
}

/**
 * Which boards the applications actually came from.
 *
 * Sorted by applications sent, then by records tracked, then by name — the
 * question this answers is "where is the effort paying off", and a board with
 * forty views and no applications is not the answer however long its bar is.
 * The name breaks the tie so the order is stable across renders.
 */
export function perBoard(postings: readonly Posting[]): PerBoard {
  const rows = new Map<string, { tracked: number; applied: number }>()
  const unattributed = { tracked: 0, applied: 0 }

  for (const posting of postings) {
    const board = boardOf(posting.canonicalUrl)
    const into =
      board === null ? unattributed : (rows.get(board) ?? { tracked: 0, applied: 0 })

    into.tracked++
    if (posting.state === 'applied') into.applied++
    if (board !== null) rows.set(board, into)
  }

  return {
    rows: [...rows.entries()]
      .map(([board, counts]) => ({
        board,
        tracked: counts.tracked,
        applied: counts.applied,
        appliedRate: counts.applied / counts.tracked,
      }))
      .sort(
        (a, b) =>
          b.applied - a.applied || b.tracked - a.tracked || a.board.localeCompare(b.board),
      ),
    unattributed,
  }
}

/** Local midnight on the Monday of a timestamp's week. */
export function startOfWeek(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  // `getDay()` is Sunday-zero; shift so Monday is the start of the week.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date.getTime()
}

/** Local midnight on the first of a timestamp's month. */
export function startOfMonth(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  date.setDate(1)
  return date.getTime()
}

/**
 * A timestamp inside the bucket before this one.
 *
 * Stepping back by a fixed number of milliseconds would drift across a
 * daylight-saving boundary — the week containing the change is 23 or 25 hours
 * short of seven days — so the step goes through the calendar instead. Landing
 * anywhere inside the previous bucket is enough; the caller re-normalizes.
 */
function previous(bucketStart: number, size: BucketSize): number {
  const date = new Date(bucketStart)
  if (size === 'week') date.setDate(date.getDate() - 7)
  else date.setMonth(date.getMonth() - 1)
  return date.getTime()
}

/** Rendering helper: a rate as a whole-number percentage, or a dash. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** Rendering helper: the label for a bucket's start. */
export function formatBucket(start: number, size: BucketSize): string {
  const date = new Date(start)
  return size === 'month'
    ? date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The states, in the order the funnel reads. */
export const FUNNEL_ORDER: readonly PostingState[] = ['viewed', 'applied']
