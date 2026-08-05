import { useMemo, useState } from 'react'
import type { Posting } from '../lib/types'
import {
  formatBucket,
  formatRate,
  funnel,
  outcomes,
  overTime,
  perBoard,
  responseFunnel,
  silence,
  type BucketSize,
  type Outcomes,
  type OverTime,
  type PerBoard,
  type ResponseFunnel,
  type Silence,
} from '../lib/dashboard/aggregate'
import { usePostings } from './usePostings'

/**
 * The dashboard page.
 *
 * Rendering only — every number on it comes from `lib/dashboard/aggregate`,
 * which is where the tests are. The rule that file follows carries through to
 * here: a residual count that is non-zero gets shown, because a chart quietly
 * omitting records is a chart that disagrees with the panel beside it.
 */
export function Dashboard() {
  const state = usePostings()
  const [size, setSize] = useState<BucketSize>('week')

  if (state.status === 'loading') {
    return (
      <Shell>
        <p className="empty">Reading your history…</p>
      </Shell>
    )
  }

  if (state.status === 'failed') {
    return (
      <Shell>
        <div className="alert alert--negative">
          <p>
            <strong>Could not read your history.</strong> Nothing has been changed or lost —
            this is a problem reaching the database, not with what is in it.
          </p>
          <p className="alert__detail">{state.message}</p>
        </div>
      </Shell>
    )
  }

  if (state.postings.length === 0) {
    return (
      <Shell>
        <p className="empty">
          Nothing saved yet. Open the side panel on a job posting and file the first one —
          the views here need a few records before they say anything useful.
        </p>
      </Shell>
    )
  }

  return (
    <Shell count={state.postings.length}>
      <Views postings={state.postings} size={size} onSize={setSize} />
    </Shell>
  )
}

function Views({
  postings,
  size,
  onSize,
}: {
  postings: Posting[]
  size: BucketSize
  onSize: (size: BucketSize) => void
}) {
  const stats = useMemo(() => funnel(postings), [postings])
  const replies = useMemo(() => responseFunnel(postings), [postings])
  const ended = useMemo(() => outcomes(postings), [postings])
  const quiet = useMemo(() => silence(postings), [postings])
  const timeline = useMemo(() => overTime(postings, { size }), [postings, size])
  const boards = useMemo(() => perBoard(postings), [postings])

  return (
    <>
      <section className="card" aria-labelledby="funnel-heading">
        <h2 id="funnel-heading">Where things stand</h2>
        <div className="figures">
          <Figure value={stats.tracked} label="tracked" />
          <Figure value={stats.viewed} label="viewed, not applied" />
          <Figure value={stats.applied} label="applied" tone="positive" />
          <Figure value={formatRate(stats.appliedRate)} label="of what you saw" />
        </div>
        <Funnel viewed={stats.viewed} applied={stats.applied} tracked={stats.tracked} />
      </section>

      <section className="card" aria-labelledby="replies-heading">
        <h2 id="replies-heading">After you applied</h2>
        <Replies replies={replies} ended={ended} quiet={quiet} />
      </section>

      <section className="card" aria-labelledby="time-heading">
        <div className="card__head">
          <h2 id="time-heading">Over time</h2>
          <div className="toggle" role="group" aria-label="Bucket size">
            {(['week', 'month'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="toggle__option"
                aria-pressed={size === option}
                onClick={() => onSize(option)}
              >
                {option === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
        <Timeline timeline={timeline} />
        <Residuals timeline={timeline} />
      </section>

      <section className="card" aria-labelledby="boards-heading">
        <h2 id="boards-heading">Per board</h2>
        <Boards boards={boards} />
      </section>
    </>
  )
}

function Shell({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <main className="dash">
      <header className="dash__head">
        <h1 className="wordmark">JourneyTracker</h1>
        {count !== undefined && (
          <p className="dash__count">
            {count} {count === 1 ? 'posting' : 'postings'}
          </p>
        )}
      </header>
      {children}
    </main>
  )
}

function Figure({
  value,
  label,
  tone,
}: {
  value: number | string
  label: string
  tone?: 'positive'
}) {
  return (
    <div className="figure">
      <span className={`figure__value${tone ? ` figure__value--${tone}` : ''}`}>
        {value}
      </span>
      <span className="figure__label">{label}</span>
    </div>
  )
}

/**
 * Two bars sharing one denominator.
 *
 * Not a tapering funnel shape: `viewed` and `applied` are exclusive states
 * (decision 8), not successive stages that the same record passes through, so
 * drawing one narrowing into the other would claim a progression the data does
 * not describe.
 */
function Funnel({
  viewed,
  applied,
  tracked,
}: {
  viewed: number
  applied: number
  tracked: number
}) {
  const share = (n: number) => (tracked === 0 ? 0 : (n / tracked) * 100)

  return (
    <div className="funnel">
      <div className="funnel__row">
        <span className="funnel__label">Viewed</span>
        <span className="funnel__track">
          <span className="funnel__bar" style={{ width: `${share(viewed)}%` }} />
        </span>
        <span className="funnel__value">{viewed}</span>
      </div>
      <div className="funnel__row">
        <span className="funnel__label">Applied</span>
        <span className="funnel__track">
          <span
            className="funnel__bar funnel__bar--positive"
            style={{ width: `${share(applied)}%` }}
          />
        </span>
        <span className="funnel__value">{applied}</span>
      </div>
    </div>
  )
}

/**
 * What happened after the applications went in.
 *
 * Unlike the `Funnel` above, this one **is** drawn as a taper, and the
 * difference is real rather than stylistic: `viewed` and `applied` are exclusive
 * states, whereas `stage` is the furthest point a single application reached, so
 * each row here genuinely is a subset of the one above it. The bars can only
 * narrow.
 *
 * With nothing applied to, none of it is drawn. Zero percent is a finding — it
 * says nobody replied — and a database with no applications in it has not earned
 * the right to say that about anyone.
 */
function Replies({
  replies,
  ended,
  quiet,
}: {
  replies: ResponseFunnel
  ended: Outcomes
  quiet: Silence
}) {
  if (replies.applied === 0) {
    return (
      <p className="empty">
        Nothing applied to yet. Set a posting’s status to <strong>applied</strong> in the
        side panel and this fills in.
      </p>
    )
  }

  const share = (n: number) => (n / replies.applied) * 100
  const rows: Array<{ label: string; value: number; positive?: boolean }> = [
    { label: 'Applied', value: replies.applied },
    { label: 'Heard back', value: replies.heardBack },
    { label: 'Interviewed', value: replies.interviewed },
    { label: 'Offers', value: replies.offers, positive: true },
  ]

  return (
    <>
      <div className="figures">
        <Figure value={formatRate(replies.responseRate)} label="replied" />
        <Figure value={formatRate(replies.interviewRate)} label="reached an interview" />
        <Figure value={replies.offers} label="offers" tone="positive" />
        <Figure value={ended.open} label="still open" />
      </div>

      <div className="funnel">
        {rows.map((row) => (
          <div className="funnel__row" key={row.label}>
            <span className="funnel__label">{row.label}</span>
            <span className="funnel__track">
              <span
                className={`funnel__bar${row.positive ? ' funnel__bar--positive' : ''}`}
                style={{ width: `${share(row.value)}%` }}
              />
            </span>
            <span className="funnel__value">{row.value}</span>
          </div>
        ))}
      </div>

      <Endings ended={ended} />
      <Waiting quiet={quiet} />
    </>
  )
}

/**
 * How the closed applications closed.
 *
 * Every applied record is in exactly one of these four, which is what makes the
 * line safe to read as a breakdown rather than as four unrelated counts. The
 * zeros are printed rather than skipped: "0 offers" out of forty applications is
 * the finding, and dropping it would leave the reader to infer it from a gap.
 */
function Endings({ ended }: { ended: Outcomes }) {
  return (
    <p className="note">
      Of {ended.applied} {ended.applied === 1 ? 'application' : 'applications'}:{' '}
      {ended.open} still open, {ended.rejected} rejected, {ended.withdrawn} withdrawn,{' '}
      {ended.accepted} accepted.
    </p>
  )
}

/**
 * The applications nobody has answered.
 *
 * Derived from `appliedAt` rather than stored, which is the point — nobody goes
 * back to a record to tick "still no reply", so a field would be wrong within a
 * week and this cannot be.
 *
 * `undateable` is reported on its own terms and gated on its own count, not on
 * `waiting`. That is phase 7's defect exactly: a residual hidden whenever the
 * other half of its condition happened to be zero.
 */
function Waiting({ quiet }: { quiet: Silence }) {
  if (quiet.unanswered === 0) return null

  const notes: string[] = []

  if (quiet.waiting > 0) {
    notes.push(
      `${quiet.waiting} ${quiet.waiting === 1 ? 'has' : 'have'} had no reply for ` +
        `${quiet.thresholdDays} days or more` +
        (quiet.longestWaitDays === null
          ? ''
          : `, the longest ${quiet.longestWaitDays} days`),
    )
  }
  if (quiet.recent > 0) notes.push(`${quiet.recent} sent recently`)
  if (quiet.undateable > 0) {
    notes.push(
      `${quiet.undateable} with no date recorded, so ${quiet.undateable === 1 ? 'it cannot' : 'they cannot'} be aged`,
    )
  }

  return (
    <p className="note">
      {quiet.unanswered} still waiting on a first reply: {notes.join('; ')}.
    </p>
  )
}

/**
 * Tracked and applied as paired columns per bucket.
 *
 * Both series share one scale. Scaling them independently would make three
 * applications in a week look level with thirty views, which is the one
 * comparison this chart exists to let someone make.
 */
function Timeline({ timeline }: { timeline: OverTime }) {
  const peak = Math.max(1, ...timeline.buckets.flatMap((b) => [b.tracked, b.applied]))

  return (
    <>
      <div className="timeline" role="img" aria-label={describeTimeline(timeline)}>
        {timeline.buckets.map((bucket) => (
          <div className="timeline__bucket" key={bucket.start}>
            <div className="timeline__columns">
              <div
                className="timeline__column"
                style={{ height: `${(bucket.tracked / peak) * 100}%` }}
                title={`${bucket.tracked} tracked`}
              />
              <div
                className="timeline__column timeline__column--positive"
                style={{ height: `${(bucket.applied / peak) * 100}%` }}
                title={`${bucket.applied} applied`}
              />
            </div>
            <span className="timeline__label">
              {formatBucket(bucket.start, timeline.size)}
            </span>
          </div>
        ))}
      </div>
      <p className="legend">
        <span className="legend__swatch" /> tracked
        <span className="legend__swatch legend__swatch--positive" /> applied
      </p>
    </>
  )
}

/**
 * The records the chart above could not place.
 *
 * Rendered only when non-zero, and never silently: these are the difference
 * between the timeline's totals and the funnel's, and without them the two
 * disagree with no way to tell which one is lying.
 */
function Residuals({ timeline }: { timeline: OverTime }) {
  const { appliedWithoutDate, beforeWindow } = timeline
  const notes: string[] = []

  // Either count on its own is enough to require the note, because the two move
  // independently: `overTime` places `createdAt` and `appliedAt` separately, so
  // a job saved today and applied to six months ago — back-filled by hand, or
  // restored from a backup — lands in `beforeWindow.applied` with
  // `beforeWindow.tracked` still at zero. Gating on `tracked` alone dropped it,
  // leaving the funnel claiming an application the chart did not show.
  if (beforeWindow.tracked > 0 || beforeWindow.applied > 0) {
    const parts: string[] = []
    if (beforeWindow.tracked > 0) parts.push(`${beforeWindow.tracked} tracked`)
    if (beforeWindow.applied > 0) parts.push(`${beforeWindow.applied} applied`)

    notes.push(`${parts.join(' and ')} before this window`)
  }
  if (appliedWithoutDate > 0) {
    notes.push(
      `${appliedWithoutDate} applied with no date recorded, so ${appliedWithoutDate === 1 ? 'it is' : 'they are'} not on the chart`,
    )
  }

  if (notes.length === 0) return null

  return <p className="note">Not shown above: {notes.join('; ')}.</p>
}

function Boards({ boards }: { boards: PerBoard }) {
  const peak = Math.max(1, ...boards.rows.map((row) => row.tracked))

  return (
    <>
      <table className="boards">
        <thead>
          <tr>
            <th scope="col">Board</th>
            <th scope="col" className="boards__num">
              Tracked
            </th>
            <th scope="col" className="boards__num">
              Applied
            </th>
            <th scope="col" className="boards__num">
              Rate
            </th>
          </tr>
        </thead>
        <tbody>
          {boards.rows.map((row) => (
            <tr key={row.board}>
              <th scope="row">
                <span className="boards__name">{row.board}</span>
                <span className="boards__track">
                  <span
                    className="boards__bar"
                    style={{ width: `${(row.tracked / peak) * 100}%` }}
                  />
                </span>
              </th>
              <td className="boards__num">{row.tracked}</td>
              <td className="boards__num">{row.applied}</td>
              <td className="boards__num">{formatRate(row.appliedRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {boards.unattributed.tracked > 0 && (
        <p className="note">
          Not shown above: {boards.unattributed.tracked} with no board to attribute them to
          {boards.unattributed.applied > 0 &&
            `, ${boards.unattributed.applied} of them applied`}
          . These were entered by hand, or saved without a usable link.
        </p>
      )}
    </>
  )
}

/** The chart's content as a sentence, for anyone not looking at the columns. */
function describeTimeline(timeline: OverTime): string {
  const tracked = timeline.buckets.reduce((n, b) => n + b.tracked, 0)
  const applied = timeline.buckets.reduce((n, b) => n + b.applied, 0)
  const span = timeline.buckets.length

  return `${tracked} tracked and ${applied} applied over the last ${span} ${timeline.size}s.`
}
