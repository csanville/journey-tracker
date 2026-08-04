/**
 * The dashboard's one source of data.
 *
 * Three states rather than two, and the distinction is the point: "still
 * loading", "loaded and empty", and "could not read" are three different
 * statements about someone's records, and only one of them should ever render as
 * "nothing here yet". `RecentPostings` already keeps the first two apart for the
 * same reason, and phase 6 spent a defect on collapsing them — a dialog offering
 * to erase zero records over a full database, because the count fell back to
 * zero before the worker answered.
 */

import { useEffect, useState } from 'react'
import type Dexie from 'dexie'
import type { Posting } from '../lib/types'
import { openForReading, subscribeToPostings } from './db'

export type PostingsState =
  | { status: 'loading' }
  | { status: 'ready'; postings: Posting[] }
  | { status: 'failed'; message: string }

export function usePostings(): PostingsState {
  const [state, setState] = useState<PostingsState>({ status: 'loading' })

  useEffect(() => {
    let db: Dexie | null = null
    let stop: (() => void) | null = null
    let cancelled = false

    const fail = (error: unknown) => {
      if (cancelled) return
      console.error('[JourneyTracker] dashboard could not read the database', error)
      setState({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }

    void (async () => {
      try {
        const opened = await openForReading()

        // The effect can be torn down while the open is still in flight —
        // React's strict mode does exactly that on mount. Closing here rather
        // than leaving it to the cleanup below, which has already run and
        // captured a null.
        if (cancelled) {
          opened.close()
          return
        }

        db = opened
        stop = subscribeToPostings(
          opened,
          (postings) => {
            if (!cancelled) setState({ status: 'ready', postings })
          },
          fail,
        )
      } catch (error) {
        fail(error)
      }
    })()

    return () => {
      cancelled = true
      stop?.()
      db?.close()
    }
  }, [])

  return state
}
