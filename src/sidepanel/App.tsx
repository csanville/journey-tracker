import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '../lib/client'
import { openDashboard } from '../lib/dashboard-tab'
import type { DetectionSummary } from '../lib/detection'
import { isEvent } from '../lib/events'
import type { StatusReport } from '../lib/messages'
import { requestPersistence } from '../lib/persistence'
import type { Posting } from '../lib/types'
import { BackupSection } from './BackupSection'
import { activeTabDetection } from './detection-client'
import { PostingForm } from './PostingForm'
import { RecentPostings } from './RecentPostings'
import { markApplied } from './submission'

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
  /** A posting whose confirmation page was just seen, awaiting an answer. */
  const [submitted, setSubmitted] = useState<Posting | null>(null)
  /**
   * A record the user asked to edit — a request handed to the form, which owns
   * whether it can be taken. Held here because the list that raises it is here.
   */
  const [editing, setEditing] = useState<Posting | null>(null)
  const version = chrome.runtime.getManifest().version

  /**
   * Mirrors `editing` for the effect that must not close over a changing value.
   *
   * `announceSubmitted` is built once and lives in a listener for the life of
   * the panel; reading `editing` directly would pin it to whatever was open when
   * the listener was installed.
   */
  const editingId = useRef<string | null>(null)
  editingId.current = editing?.id ?? null

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

  /**
   * Postings whose prompt has already been answered, either way.
   *
   * Decision 13's amendment names "an unanswered question" as a state that must
   * not be silently re-entered, and dismissing has to leave a mark or there is
   * no reachable state in which the answer sticks: a reload of the confirmation
   * page re-fires the event, the worker re-matches the same record, and the
   * identical banner returns over a question the user just answered. That is
   * the same failure `PostingForm`'s own `dismissed` flag exists to prevent,
   * arriving in a new component.
   *
   * A ref rather than state — nothing renders from it, and it must not
   * re-trigger the effect that reads it. Its bound is the life of the panel,
   * which is the right scope: re-prompting requires the user to go back to a
   * confirmation page deliberately.
   */
  const answered = useRef(new Set<string>())

  /** Retires a prompt, whichever button retired it. */
  const answer = useCallback((postingId: string) => {
    answered.current.add(postingId)
    // Cleared only if it is still the posting being answered. `onConfirm`
    // awaits a write first, and clearing unconditionally after that await threw
    // away a *different* confirmation that had arrived in the gap — the
    // check-then-act-across-an-await shape this project has now found in four
    // phases running.
    setSubmitted((current) => (current?.id === postingId ? null : current))
  }, [])

  /**
   * Reads the record a confirmation page pointed at, so the prompt can name it.
   *
   * The worker sends an id rather than the record, so this is where the copy
   * shown to the user comes from — read at prompt time, not whenever the event
   * happened to be built. A record that has since gone, that already says
   * `applied` because the user got there first, or whose prompt has already
   * been answered produces nothing: there is nothing left to ask.
   */
  const announceSubmitted = useCallback(async (postingId: string) => {
    if (answered.current.has(postingId)) return
    // The form already has this record open, so the prompt would be a second
    // owner of it: confirming writes `state: 'applied'`, and the edit in the
    // form — loaded before that write — would then save its own stale `state`
    // straight back over it. The user is looking at the field in question and
    // can set it themselves.
    if (editingId.current === postingId) return

    try {
      const posting = await send('posting/get', { id: postingId })
      if (!posting || posting.state === 'applied') return
      // Re-checked after the round trip: the user may have answered a prompt
      // for this same record while the read was in flight, or opened it for
      // editing, either of which settles the question this was going to ask.
      if (answered.current.has(posting.id) || editingId.current === posting.id) return

      setSubmitted(posting)
    } catch (error) {
      // The user is about to save this by hand, exactly as they did before this
      // feature existed. Not worth a banner.
      console.debug('[JourneyTracker] could not read the submitted posting', error)
    }
  }, [])

  /**
   * The other half of the guard in `announceSubmitted`, which was one-directional.
   *
   * That one refuses to *raise* a prompt for a record already open in the form.
   * It does nothing about a prompt that is already up when the user opens the
   * same record — which is the likelier order, because the prompt names a
   * company and a title and says nothing else, so clicking the row to see which
   * record it means is the obvious way to answer it.
   *
   * Left alone, both own the record and the form wins. The draft was seeded
   * before the prompt was confirmed, so it still holds `state: 'viewed'`;
   * confirming writes `applied`, and the next Save — enabled whether or not
   * anything was typed — writes `viewed` and a null `appliedAt` straight back
   * over it. The user's explicit "Yes, applied" disappears, taking with it the
   * date the whole response funnel is anchored on.
   *
   * Retired rather than marked answered. `announceSubmitted` re-reads the record
   * and declines to ask about one that already says `applied`, so a later event
   * can safely raise the question again if it is still genuinely open — whereas
   * marking it answered would suppress it for the life of the panel on the
   * strength of the user merely having looked.
   */
  useEffect(() => {
    setSubmitted((current) => (current && current.id === editing?.id ? null : current))
  }, [editing?.id])

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
      if (!isEvent(message)) return

      // Decision 16 said the union would grow to a point where "refresh
      // everything" stopped being the right answer, and this is it: a
      // submission is a question about one record, and re-reading the active
      // tab's detection would neither ask it nor answer it.
      if (message.type === 'application/submitted') {
        void announceSubmitted(message.postingId)
        return
      }

      void refreshDetection()
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
  }, [refreshDetection, announceSubmitted])

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

      {submitted && (
        // Keyed by record, so the banner's own `saving`/`failure` state cannot
        // outlive the posting it was about. Without it a second confirmation
        // arriving while the first was mid-save inherited "Saving…" — or a
        // failure message — under a different job's name.
        <SubmissionPrompt
          key={submitted.id}
          posting={submitted}
          onDismiss={() => answer(submitted.id)}
          onConfirm={async () => {
            await send('posting/upsert', { posting: markApplied(submitted, Date.now()) })
            answer(submitted.id)
            await refresh()
          }}
        />
      )}

      <PostingForm
        detection={detection}
        editing={editing}
        onStopEditing={() => setEditing(null)}
        onSaved={() => {
          void refresh()
          // A save wipes the form, so the next thing the user sees should be
          // this page offering itself again rather than a stale banner about
          // the posting they just filed.
          void refreshDetection()
        }}
        onDeleted={() => {
          void refresh()
          // The revisit banner, which is the panel's own claim about the active
          // tab and is now false. The *badge* is not this call's doing and an
          // earlier version of this comment said it was: `detection/get` only
          // reads the cache, so nothing here reaches the toolbar. The worker
          // repaints it from the `posting/delete` handler, which is the only
          // context that can.
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
          {/*
            The dashboard is a tab rather than a view in here: a status funnel
            and a per-board table do not fit in 360px. Neither opening a tab nor
            focusing one is permission-gated — see `lib/dashboard-tab.ts` for the
            lookup that is, and why this does not use it (decision 2).

            Offered only once something is saved, because a dashboard over an
            empty database is a page of dashes and an invitation to wonder what
            broke.
          */}
          {status && status.postingCount > 0 && (
            <button type="button" className="link" onClick={() => void openDashboard()}>
              Dashboard
            </button>
          )}
        </h2>
        <RecentPostings postings={postings} onEdit={setEditing} />
      </section>

      {/*
        Above the diagnostics because it is a thing people do deliberately, and
        below the list because the list is the answer to "is my data still
        there" — which is the question that makes somebody go looking for this.
      */}
      <BackupSection status={status} onChanged={() => void refresh()} />

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

      <footer className="panel__foot">Phase 9 · editing</footer>
    </div>
  )
}

/**
 * "Looks like you applied — shall I record it?"
 *
 * Asks rather than writes, which is decision 12 in full: a detector good enough
 * to write silently would have to be good enough that a wrong write never
 * manufactures history, and this one is a URL match on one board. Asking costs
 * a dismissible banner when it is wrong.
 *
 * It names the posting rather than saying "this page". By the time this shows,
 * the tab is on a confirmation page that says almost nothing about the job, and
 * the whole question is whether the record it means is the right one — which
 * the user can only answer if they can see which record that is.
 *
 * Both buttons resolve it. There is no third state where the banner lingers
 * unanswered, because the next confirmation would replace it and the first
 * question would vanish having never been answered — the shape decision 13's
 * amendment names as "an unanswered question" and suppresses swaps for.
 */
function SubmissionPrompt({
  posting,
  onConfirm,
  onDismiss,
}: {
  posting: Posting
  onConfirm: () => Promise<void>
  onDismiss: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  return (
    // The revisit notice's styling, because it is the same kind of thing: the
    // panel telling you something about a record you already have.
    <div className="notice notice--revisit" role="status">
      <p className="notice__title">Looks like you applied.</p>
      <p className="notice__detail">
        {posting.company} — {posting.jobTitle}
      </p>
      {failure && <p className="notice__detail">Could not save it: {failure}</p>}
      <div className="notice__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={saving}
          onClick={() => {
            setSaving(true)
            setFailure(null)
            void onConfirm()
              .catch((error: unknown) => {
                // Left on screen rather than dismissed, so the answer the user
                // gave is not silently discarded by a failed write.
                setFailure(error instanceof Error ? error.message : String(error))
              })
              .finally(() => setSaving(false))
          }}
        >
          {saving ? 'Saving…' : 'Yes, applied'}
        </button>
        <button type="button" className="button" disabled={saving} onClick={onDismiss}>
          Not this one
        </button>
      </div>
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
