import { useCallback, useEffect, useState } from 'react'
import { send } from '../lib/client'
import type { StatusReport } from '../lib/messages'
import { requestPersistence } from '../lib/persistence'
import type { Posting } from '../lib/types'
import { PostingForm } from './PostingForm'
import { RecentPostings } from './RecentPostings'

/**
 * The panel proper: file a posting, see what has been filed.
 *
 * Everything still goes through the message layer rather than touching storage
 * directly, so the worker stays the only writer (decision 4). The diagnostics
 * that used to be the whole panel are folded away at the bottom — they are worth
 * keeping, since a storage or migration problem is otherwise invisible, but they
 * are not what this is for any more.
 */
export function App() {
  const [status, setStatus] = useState<StatusReport | null>(null)
  /** `null` until the first load answers — distinct from "loaded, and empty". */
  const [postings, setPostings] = useState<Posting[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const version = chrome.runtime.getManifest().version

  const refresh = useCallback(async (): Promise<StatusReport | null> => {
    try {
      const [nextStatus, nextPostings] = await Promise.all([
        send('status', {}),
        send('posting/list', {}),
      ])
      setStatus(nextStatus)
      setPostings(nextPostings)
      setFailure(null)
      return nextStatus
    } catch (error) {
      console.error('[JourneyTracker] could not reach the service worker', error)
      setFailure(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const first = await refresh()
      if (cancelled || !first) return

      // `persist()` is exposed to Window contexts only, so this panel is the
      // one place in the extension that can ask — the worker can merely read
      // the answer. Only worth asking when `unlimitedStorage` did not already
      // cover us, since either defence alone is sufficient.
      if (first.evictionSafe) return

      try {
        await requestPersistence()
        const rechecked = await send('storage/reassess', {})
        if (!cancelled) setStatus(rechecked)
      } catch (error) {
        // The worker can die between the two calls — that is ordinary for MV3
        // and is why the client retries at all. Unhandled, this was a silent
        // rejection that left the panel showing pre-persist state with nothing
        // said.
        console.error('[JourneyTracker] could not re-check storage protection', error)
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [refresh])

  return (
    <div className="panel">
      <header className="panel__head">
        <h1 className="wordmark">
          Journey<span className="wordmark__tail">Tracker</span>
        </h1>
        <span className="version">v{version}</span>
      </header>

      {failure && (
        <div className="notice notice--bad" role="alert">
          <p>Could not reach the extension's service worker — {failure}</p>
          <div className="notice__actions">
            {/* Otherwise only a successful save clears this, and saving is the
                thing that is not working. */}
            <button type="button" className="button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </div>
      )}

      {status && !status.evictionSafe && (
        <p className="notice" role="status">
          Chrome may evict this extension's data if the disk runs low. Exporting a backup
          will matter more than usual until that changes.
        </p>
      )}

      <PostingForm onSaved={() => void refresh()} />

      <section className="section">
        <h2 className="section__head">
          Recent
          {status && status.postingCount > 0 && (
            <span className="section__count">{status.postingCount}</span>
          )}
        </h2>
        <RecentPostings postings={postings} />
      </section>

      <details className="diagnostics">
        <summary>Diagnostics</summary>
        <dl className="probes">
          <Row label="Service worker">{status ? 'responding' : 'no answer'}</Row>
          <Row label="Schema">
            {status
              ? `v${status.schemaVersion}${
                  status.dataVersion === status.schemaVersion
                    ? ''
                    : ` · data at v${status.dataVersion}`
                }`
              : '—'}
          </Row>
          <Row label="Storage">
            {!status
              ? '—'
              : status.evictionSafe
                ? status.storageUnlimited
                  ? 'protected · unlimitedStorage'
                  : 'protected · persisted'
                : 'evictable'}
          </Row>
          <Row label="Postings">{status ? String(status.postingCount) : '—'}</Row>
        </dl>
      </details>

      <footer className="panel__foot">Phase 3 · the form</footer>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="probe">
      <dt>{label}</dt>
      <dd className="probe__value">{children}</dd>
    </div>
  )
}
