import { useEffect, useState } from 'react'

type ProbeState = 'checking' | 'ok' | 'failed'

/**
 * Phase 0 is a walking skeleton: it exists to prove the toolchain reaches
 * Chrome at all. Rather than render a static placeholder, the panel actually
 * exercises the two APIs everything later depends on — the manifest and
 * chrome.storage — so a green panel means the boundary really works.
 */
export function App() {
  const [storage, setStorage] = useState<ProbeState>('checking')
  const version = chrome.runtime.getManifest().version

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        await chrome.storage.local.set({ 'jt:probe': Date.now() })
        const read = await chrome.storage.local.get('jt:probe')
        await chrome.storage.local.remove('jt:probe')
        if (!cancelled) setStorage(read['jt:probe'] ? 'ok' : 'failed')
      } catch (error) {
        console.error('[JourneyTracker] storage probe failed', error)
        if (!cancelled) setStorage('failed')
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
          The application form lands in phase 2. This panel is here to prove the
          extension loads, renders and can reach browser storage.
        </p>

        <dl className="probes">
          <div className="probe">
            <dt>Side panel</dt>
            <dd className="probe__value probe__value--ok">rendering</dd>
          </div>
          <div className="probe">
            <dt>Extension storage</dt>
            <dd className={`probe__value probe__value--${storage}`}>
              {storage === 'checking'
                ? 'checking…'
                : storage === 'ok'
                  ? 'read and write confirmed'
                  : 'unreachable — see console'}
            </dd>
          </div>
        </dl>
      </div>

      <footer className="panel__foot">Phase 0 · walking skeleton</footer>
    </div>
  )
}
