import { useId, useState } from 'react'
import type { Posting } from '../lib/types'

/**
 * The saved postings, and the way back into one of them.
 *
 * Was read-only through phase 8, which is what made phase 8's own fields inert:
 * `stage` and `outcome` change over weeks and nothing could reopen a record to
 * change them. This is now the panel's only entry point to an edit, so it has to
 * do more than reassure — it has to *find* things.
 *
 * Five rows is right for "did that save work", and useless for "where is the job
 * I applied to last month". So the list has two modes: the recent few by default,
 * and a filtered view over every record once something is typed. The filter is a
 * plain case-insensitive substring over company and title — `normalizeCompany`
 * exists to make join keys agree, not to second-guess what somebody typed into a
 * search box.
 */
const SHOWN = 5

/**
 * How many matches to render. The panel is ~360px and this list sits above the
 * backup section and the diagnostics; an unbounded result set would bury both.
 * The count line says when there are more, so the cap never hides its own effect.
 */
const MATCH_LIMIT = 20

export function matches(postings: Posting[], filter: string): Posting[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return postings

  return postings.filter(
    (posting) =>
      posting.company.toLowerCase().includes(needle) ||
      posting.jobTitle.toLowerCase().includes(needle),
  )
}

export function RecentPostings({
  postings,
  onEdit,
}: {
  postings: Posting[] | null
  onEdit: (posting: Posting) => void
}) {
  const [filter, setFilter] = useState('')
  const filterId = useId()
  const filtering = filter.trim().length > 0

  // `null` is "we have not been told yet", which is what a failed load also
  // looks like. Claiming "nothing saved yet" there would be a false statement
  // about someone's records, in the one place this panel exists to reassure
  // them the records are still there.
  if (postings === null) {
    return <p className="empty">Loading…</p>
  }

  if (postings.length === 0) {
    return <p className="empty">Nothing saved yet. The form above files the first one.</p>
  }

  const found = matches(postings, filter)
  const shown = filtering ? found.slice(0, MATCH_LIMIT) : found.slice(0, SHOWN)

  return (
    <>
      <p className="field field--filter">
        <label className="visually-hidden" htmlFor={filterId}>
          Find a saved posting
        </label>
        <input
          id={filterId}
          className="field__input"
          type="search"
          value={filter}
          placeholder="Find a saved posting…"
          onChange={(event) => setFilter(event.target.value)}
        />
      </p>

      {/*
        A fourth read state, and the one worth being careful about. "Loaded,
        non-empty, but nothing matches what you typed" is not "nothing saved
        yet" — the records are all still there, and saying otherwise about
        somebody's data is this project's oldest recurring failure.
      */}
      {shown.length === 0 ? (
        <p className="empty">
          No saved posting matches “{filter.trim()}”. {postings.length} are stored.
        </p>
      ) : (
        <>
          <ul className="recent">
            {shown.map((posting) => (
              <li className="recent__item" key={posting.id}>
                <button
                  type="button"
                  className="recent__open"
                  onClick={() => onEdit(posting)}
                >
                  <span className="recent__company">{posting.company}</span>
                  <span className="recent__title">{posting.jobTitle}</span>
                  <span className="recent__meta">
                    <span className={`pill pill--${posting.state}`}>{posting.state}</span>
                    {/* What happened after, where it is known. This is what
                        somebody reopening a record has come to check, so the
                        list saying it saves opening the ones that have not
                        moved. Absent stays absent: no stage is "nothing heard
                        yet", which is the ordinary state of a recent
                        application and not a thing to go and fix. */}
                    {posting.stage && (
                      <span className="pill pill--stage">{posting.stage}</span>
                    )}
                    {posting.outcome && (
                      <span className="pill pill--outcome">{posting.outcome}</span>
                    )}
                    <time dateTime={new Date(posting.updatedAt).toISOString()}>
                      {formatWhen(posting.updatedAt)}
                    </time>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {/*
            Says what is on screen against what exists, never one without the
            other. A bare "47" beside two filtered rows, or a filtered list with
            no count at all, are both the same false claim about how much the
            user is looking at.
          */}
          {filtering && (
            <p className="recent__count">
              {shown.length < found.length
                ? `Showing ${shown.length} of ${found.length} matches`
                : `${found.length} of ${postings.length} saved`}
            </p>
          )}
        </>
      )}
    </>
  )
}

/**
 * Relative for the first week, then a plain date.
 *
 * Counted in calendar days, not in elapsed 24-hour blocks. Something saved at
 * 23:00 and read at 08:00 is nine hours old but was plainly *yesterday*, and
 * "today" would be wrong in the way people notice.
 */
export function formatWhen(timestamp: number, now: number = Date.now()): string {
  const days = Math.round((midnightOf(now) - midnightOf(timestamp)) / 86_400_000)

  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/** Local midnight, so the comparison is between calendar days. */
function midnightOf(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
