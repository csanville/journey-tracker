import { useEffect, useState } from 'react'
import { send } from '../lib/client'
import type { StatusReport } from '../lib/messages'

type Probe =
  | { phase: 'checking' }
  | { phase: 'ok'; status: StatusReport }
  | { phase: 'failed'; error: string }

/**
 * Still the diagnostic panel, not the product UI — the form arrives in phase 3.
 *
 * It talks to the service worker over the real message layer rather than
 * touching storage directly, so opening the panel exercises the whole path the
 * extension actually depends on: worker wakes, database opens, migrations run,
 * request round-trips.
 */
export function App() {
  const [probe, setProbe] = useState<Probe>({ phase: 'checking' })
  const version = chrome.runtime.getManifest().version

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const status = await send('status', {})
        if (!cancelled) setProbe({ phase: 'ok', status })
      } catch (error) {
        console.error('[JourneyTracker] status request failed', error)
        if (!cancelled) {
          setProbe({
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="panel">
      <header className="panel__head">
        <h1 className="wordmark">
          Journey<span className="wordmark__tail">Tracker</span>
        </h1>
        <span className="version">v{version}</span>
      </header>

      <div className="stack">
        <p className="lede">
          The application form lands in phase 3. This panel checks that the
          service worker, the database and the message layer between them are
          all working.
        </p>

        <dl className="probes">
          <Row label="Service worker" state={probe.phase === 'ok' ? 'ok' : probe.phase}>
            {probe.phase === 'checking' && 'checking…'}
            {probe.phase === 'ok' && 'responding'}
            {probe.phase === 'failed' && probe.error}
          </Row>

          {probe.phase === 'ok' && (
            <>
              <Row label="Schema" state="ok">
                v{probe.status.schemaVersion}
                {probe.status.dataVersion !== probe.status.schemaVersion &&
                  ` · data at v${probe.status.dataVersion}`}
              </Row>

              <Row label="Storage" state={probe.status.evictionSafe ? 'ok' : 'warn'}>
                {probe.status.evictionSafe
                  ? probe.status.storageUnlimited
                    ? 'protected · unlimitedStorage'
                    : 'protected · persisted'
                  : 'evictable — records may be cleared'}
              </Row>

              <Row label="Postings" state="ok">
                {probe.status.postingCount}
              </Row>
            </>
          )}
        </dl>

        {probe.phase === 'ok' && !probe.status.evictionSafe && (
          <p className="notice">
            Chrome may evict this extension's data if the disk runs low. Exporting
            a backup will matter more than usual until that changes.
          </p>
        )}
      </div>

      <footer className="panel__foot">Phase 1 · schema and storage</footer>
    </div>
  )
}

function Row({
  label,
  state,
  children,
}: {
  label: string
  state: 'checking' | 'ok' | 'warn' | 'failed'
  children: React.ReactNode
}) {
  return (
    <div className="probe">
      <dt>{label}</dt>
      <dd className={`probe__value probe__value--${state}`}>{children}</dd>
    </div>
  )
}
