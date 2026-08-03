import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '../lib/client'
import type { DetectionSummary } from '../lib/detection'
import { isEvent } from '../lib/events'
import type { StatusReport } from '../lib/messages'
import { requestPersistence } from '../lib/persistence'
import type { Posting } from '../lib/types'
import { activeTabDetection } from './detection-client'
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
  const [detection, setDetection] = useState<DetectionSummary | null>(null)
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

  /**
   * Re-asks what the active tab is showing.
   *
   * Called on mount, on focus, when the user switches tabs, and when a content
   * script reports something new. The last two are what phase 5 adds: the form
   * follows the tab rather than waiting to be looked at.
   *
   * The counter is not ceremony. This fires on mount *and* on every focus, so
   * two calls overlap whenever the user clicks into the panel while the first
   * is still waiting on a cold worker — and on a cold worker `send` retries for
   * the better part of a second. Resolved out of order, the older answer wins
   * and the panel offers the tab the user has already left. Only the newest
   * request is allowed to set state, and after unmount none of them is.
   */
  const latestDetection = useRef(0)

  const refreshDetection = useCallback(async () => {
    const mine = ++latestDetection.current

    try {
      const next = await activeTabDetection()
      if (mine === latestDetection.current) setDetection(next)
    } catch (error) {
      // Not reaching the worker is already reported by `refresh`, and a missing
      // detection is an ordinary state — most pages are not job postings — so
      // this failure is not worth a second banner.
      console.debug('[JourneyTracker] could not read the active tab', error)
    }
  }, [])

  useEffect(() => {
    void refreshDetection()

    const onFocus = () => void refreshDetection()
    globalThis.addEventListener('focus', onFocus)

    /**
     * Switching tabs. `onActivated` reports a tab id and nothing else, so it
     * needs no `tabs` permission — the same line decision 2 draws for
     * `chrome.tabs.query`: which tab, never where it is.
     */
    const onActivated = () => void refreshDetection()
    chrome.tabs.onActivated.addListener(onActivated)

    /**
     * A content script reporting while the panel is already open — a board that
     * rendered late, or an SPA the user clicked through without a page load.
     *
     * Deliberately not filtered by the event's `tabId`. Doing that would mean
     * the panel keeping its own idea of which tab is active, and that second
     * copy is exactly the thing that goes stale; `refreshDetection` asks Chrome,
     * which is the answer rather than a cache of it. A report from a background
     * tab costs one message and resolves to the same detection, and the
     * ordering guard above makes an overlapping pair safe.
     */
    const onEvent = (message: unknown) => {
      if (isEvent(message)) void refreshDetection()
    }
    chrome.runtime.onMessage.addListener(onEvent)

    return () => {
      globalThis.removeEventListener('focus', onFocus)
      chrome.tabs.onActivated.removeListener(onActivated)
      chrome.runtime.onMessage.removeListener(onEvent)
      // Retires every request in flight, so none of them sets state on an
      // unmounted panel.
      latestDetection.current++
    }
  }, [refreshDetection])

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

      <PostingForm
        detection={detection}
        onSaved={() => {
          void refresh()
          // A save wipes the form, so the next thing the user sees should be
          // this page offering itself again rather than a stale banner about
          // the posting they just filed.
          void refreshDetection()
        }}
      />

      {/*
        The capture gesture cannot be a button here — `activeTab` is granted by
        an action, a context menu item, a keyboard shortcut or the omnibox, and
        a click inside an extension page is none of those. So the panel does the
        only thing it can and says where the gesture lives. Shown only when
        nothing was detected, which is exactly when somebody would be wondering.

        The second sentence exists because the panel now opens on a refused read
        as well as a successful one (see `captureAndShow`). Without it, somebody
        who right-clicked a PDF was answered with a panel telling them to
        right-click the page — advice they had just taken, which reads as a
        broken menu item rather than as a limit. Naming the three refusals is
        cheaper than a channel back from the worker saying which one happened,
        and it is the same short list every time.
      */}
      {detection === null && (
        <p className="hint hint--capture">
          Not a board this reads automatically? Right-click the page and choose{' '}
          <strong>Read this page into JourneyTracker</strong>. Chrome allows no extension to
          read its own pages, the Web Store, or a PDF.
        </p>
      )}

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
          {/* The one probe that answers "is the content script running?", which
              is otherwise invisible from inside the panel. */}
          <Row label="This page">
            {detection
              ? `${detection.source} · ${Math.round(detection.confidence * 100)}% coverage`
              : 'no posting detected'}
          </Row>
        </dl>
      </details>

      <footer className="panel__foot">Phase 5 · live sync</footer>
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
