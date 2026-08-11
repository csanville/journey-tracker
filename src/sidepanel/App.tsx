import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { send } from '../lib/client'
import { openDashboard } from '../lib/dashboard-tab'
import type { CachedFailedParse, DetectionSummary } from '../lib/detection'
import { formatReport } from '../lib/diagnostics'
import { isEvent } from '../lib/events'
import type { StatusReport } from '../lib/messages'
import { requestPersistence } from '../lib/persistence'
import type { Posting } from '../lib/types'
import { BackupSection } from './BackupSection'
import { activeTabDetection, activeTabDiagnostic } from './detection-client'
import { PostingForm } from './PostingForm'
import { RecentPostings } from './RecentPostings'
import { panelReport } from './report'
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
  /**
   * Why the active tab gave up nothing, when it said so.
   *
   * Only ever set when `detection` is null — see `refreshDetection`. It is the
   * other half of the same question, which is why it is refreshed on the same
   * triggers rather than fetched where it is rendered.
   */
  const [diagnostic, setDiagnostic] = useState<CachedFailedParse | null>(null)
  /**
   * The question currently on screen: a posting, and when its confirmation page
   * was seen.
   *
   * The date is carried because it is what gets written on confirmation. It is
   * the worker's timestamp from the moment the confirmation page was detected,
   * not the moment the user clicks — a prompt that survives a closed panel can
   * be answered days later, and `appliedAt` is what the response funnel measures
   * from.
   */
  const [submitted, setSubmitted] = useState<{
    posting: Posting
    confirmedAt: number
  } | null>(null)
  /**
   * A record the user asked to edit — a request handed to the form, which owns
   * whether it can be taken. Held here because the list that raises it is here.
   */
  const [editing, setEditing] = useState<Posting | null>(null)
  const version = chrome.runtime.getManifest().version

  /**
   * Mirrors `editing` for the callback that must not close over a changing value.
   *
   * `refreshPending` is built once and is reached from a listener that lives for
   * the life of the panel; reading `editing` directly would pin it to whatever
   * was open when the listener was installed. It also runs across awaits — a
   * `posting/get` per entry — so the ref is read at the moment each decision is
   * made rather than at the moment the pass started, which is the distinction
   * phase 9 spent a defect on.
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
      // Only asked when there is no detection: a tab can hold both, and the
      // detection is the better answer whenever there is one. Sequential rather
      // than in parallel for the same reason — the second call is not wanted at
      // all in the common case.
      const failed = next ? null : await activeTabDiagnostic()

      // Set together, and guarded together. Two separate guards would let a
      // stale diagnostic land beside a fresh detection on interleaved refreshes,
      // which is the one combination `panelReport` reads as "this page failed".
      if (mine === latestDetection.current) {
        setDetection(next)
        setDiagnostic(failed)
      }
    } catch (error) {
      // Not reaching the worker is already reported by `refresh`, and a missing
      // detection is an ordinary state — most pages are not job postings — so
      // this failure is not worth a second banner.
      console.debug('[JourneyTracker] could not read the active tab', error)
    }
  }, [])

  /**
   * Reads the pending queue and raises the first question still worth asking.
   *
   * The panel holds no list of its own. Phase 10 put the questions in
   * `chrome.storage.local` so one survives a closed panel, and the moment they
   * are written down, a copy in React state is a second thing to keep in step —
   * so this reads the store, picks the head, and renders that. Called on mount
   * and whenever the worker says the queue moved, which are the only two ways it
   * can change.
   *
   * Three things disqualify an entry, and only the first two mean the question
   * is over:
   *
   * - **The record is gone.** Deleted since the confirmation. Retired, because
   *   nothing will ever make it askable again.
   * - **It already says `applied`.** The user got there first, by hand or
   *   through the form. Retired for the same reason.
   * - **It is open in the form.** *Skipped, not retired* — see below.
   *
   * Entries are checked in order rather than filtered in parallel: the queue is
   * bounded at `MAX_PENDING`, and the common length is one.
   */
  const refreshPending = useCallback(async () => {
    try {
      const pending = await send('submission/pending', {})

      for (const entry of pending) {
        // Skipped, not retired. Retiring here would throw away a real question
        // because the user clicked the row to see which record the prompt meant
        // — which is the obvious thing to do, since the prompt names a company
        // and a title and nothing else. It also cannot be shown: the form loaded
        // this record before any confirmation was written, so confirming would
        // set `applied` and the form's next Save would put its own stale
        // `viewed` and a null `appliedAt` straight back over it. The question
        // returns by itself once editing stops, because this runs again.
        if (editingId.current === entry.postingId) continue

        const posting = await send('posting/get', { id: entry.postingId })

        if (!posting || posting.state === 'applied') {
          await send('submission/retire', { postingId: entry.postingId })
          continue
        }

        setSubmitted({ posting, confirmedAt: entry.confirmedAt })
        return
      }

      setSubmitted(null)
    } catch (error) {
      // The user is about to save this by hand, exactly as they did before this
      // feature existed. Not worth a banner.
      console.debug('[JourneyTracker] could not read pending submissions', error)
    }
  }, [])

  /**
   * Answers a question for good, then asks the next one.
   *
   * Both buttons land here, and both retire durably — decision 13's amendment
   * wants an answered question to stay answered, and before the store the only
   * place to record a dismissal was a ref that died with the panel, so "no"
   * lasted until the panel was closed.
   *
   * The re-read is what advances the queue, and it is also why nothing needs to
   * be cleared here: `refreshPending` sets the next entry or `null`, from the
   * store, after the retire has landed. The old code cleared local state after
   * an awaited write and had to guard against discarding a different
   * confirmation that arrived in the gap; there is no gap to guard now, because
   * the state is derived rather than accumulated.
   */
  const answer = useCallback(
    async (postingId: string) => {
      try {
        await send('submission/retire', { postingId })
      } catch (error) {
        // Retiring failed, so the question is still in the store and will be
        // asked again. Better than clearing the banner over a store that still
        // holds it, which would look answered and come back on the next open.
        console.debug('[JourneyTracker] could not retire a submission', error)
      }
      await refreshPending()
    },
    [refreshPending],
  )

  /**
   * Re-asks when the user stops editing, and stands down when they start.
   *
   * `refreshPending` skips the record open in the form, so both directions are
   * the same call: opening one drops its prompt if it was up, closing brings it
   * back if it is still open. Keyed on the id so it fires on a change of which
   * record is being edited, not on every render of the same one.
   */
  useEffect(() => {
    void refreshPending()
  }, [editing?.id, refreshPending])

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
      //
      // The event carries no id — it says the queue moved, and the queue is
      // read from the store. That is what makes an open panel and a closed one
      // the same path: this listener is an optimisation for the open case, and
      // removing it would cost immediacy, not correctness.
      if (message.type === 'submission/pending') {
        void refreshPending()
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
  }, [refreshDetection, refreshPending])

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
          key={submitted.posting.id}
          posting={submitted.posting}
          onDismiss={() => answer(submitted.posting.id)}
          onConfirm={async () => {
            // `confirmedAt`, not `Date.now()`. This prompt can outlive the
            // browser session that raised it, so the click is not evidence of
            // when the application happened — the confirmation page is, and the
            // worker timestamped it when it saw one.
            await send('posting/upsert', {
              posting: markApplied(submitted.posting, submitted.confirmedAt),
            })
            await answer(submitted.posting.id)
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
              : diagnostic
                ? `${diagnostic.source} read it and found nothing`
                : 'no posting detected'}
          </Row>
        </dl>

        {status && (
          <ReportToSend
            status={status}
            detection={detection}
            diagnostic={diagnostic}
            extensionVersion={version}
          />
        )}
      </details>

      <footer className="panel__foot">JourneyTracker {version}</footer>
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

/**
 * The report, shown before it is copied.
 *
 * **The preview is the payload.** What is rendered is `formatReport` of the same
 * object the button puts on the clipboard — not a summary of it, not a sample.
 * Decision 1's amendment turns on the user being able to judge what they are
 * about to paste into a public issue, and a preview that merely resembled the
 * payload would make that judgement about the wrong text. It is one string, used
 * twice.
 *
 * Rendered whether or not anything is wrong, because "is this even a healthy
 * install" is the first thing to rule out and the answer is worth having before
 * a problem rather than after one.
 */
function ReportToSend({
  status,
  detection,
  diagnostic,
  extensionVersion,
}: {
  status: StatusReport
  detection: DetectionSummary | null
  diagnostic: CachedFailedParse | null
  extensionVersion: string
}) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')

  /**
   * Stamped when the facts change, not on every render.
   *
   * `Date.now()` in the render body would move the timestamp line on every
   * repaint — a preview that never sits still, and a `<pre>` whose content
   * differs from the string copied a moment later. The memo makes `at` the
   * moment the observation was taken, which is what the line claims to be.
   */
  const text = useMemo(
    () =>
      formatReport(
        panelReport({ status, detection, diagnostic, extensionVersion, at: Date.now() }),
      ),
    [status, detection, diagnostic, extensionVersion],
  )

  // A new report is a different thing to have copied, so the acknowledgement
  // does not carry over to it.
  useEffect(() => setCopied('no'), [text])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('yes')
    } catch (error) {
      // Chrome refuses the clipboard when the document is not focused, which a
      // side panel loses easily. Saying so is better than a button that looks
      // like it worked — the text is on screen and can be selected by hand.
      console.debug('[JourneyTracker] could not write to the clipboard', error)
      setCopied('failed')
    }
  }

  return (
    <div className="report">
      <p className="report__note">
        Everything below, and nothing else, is what Copy puts on your clipboard. No company,
        job title, or page address beyond the site name.
      </p>
      <pre className="report__text">{text}</pre>
      <div className="report__actions">
        <button type="button" onClick={() => void copy()}>
          Copy report
        </button>
        {copied === 'yes' && <span className="report__said">Copied</span>}
        {copied === 'failed' && (
          <span className="report__said report__said--bad">
            Could not reach the clipboard — select the text above instead
          </span>
        )}
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
