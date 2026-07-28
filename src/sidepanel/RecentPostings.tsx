import type { Posting } from '../lib/types'

/**
 * The last few saves, so a record that has just been filed is visibly there.
 *
 * Read-only. Editing and the real views over this data are the dashboard's job
 * in phase 7; what this needs to do now is answer "did that save work, and is it
 * still there after a reload" without the user opening devtools.
 */
const SHOWN = 5

export function RecentPostings({ postings }: { postings: Posting[] }) {
  if (postings.length === 0) {
    return <p className="empty">Nothing saved yet. The form above files the first one.</p>
  }

  return (
    <ul className="recent">
      {postings.slice(0, SHOWN).map((posting) => (
        <li className="recent__item" key={posting.id}>
          <span className="recent__company">{posting.company}</span>
          <span className="recent__title">{posting.jobTitle}</span>
          <span className="recent__meta">
            <span className={`pill pill--${posting.state}`}>{posting.state}</span>
            <time dateTime={new Date(posting.updatedAt).toISOString()}>
              {formatWhen(posting.updatedAt)}
            </time>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Relative for the first week, then a plain date. */
function formatWhen(timestamp: number, now: number = Date.now()): string {
  const days = Math.floor((now - timestamp) / 86_400_000)

  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`

  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
