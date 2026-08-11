import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { send } from '../lib/client'
import type { DetectionSummary } from '../lib/detection'
import { newId } from '../lib/ids'
import { postingInputFromDetection } from '../lib/tracked'
import type { DuplicateMatch, Posting } from '../lib/types'
import {
  EMPTY_DRAFT,
  MANUAL_SAVE,
  draftErrors,
  draftFromPosting,
  isDirty,
  isSaveable,
  toPostingInput,
  today,
  type Draft,
} from './draft'
import {
  draftFromDetection,
  editContextFor,
  fieldsFilled,
  saveContextFor,
  swapAction,
} from './fill'

/**
 * How long the form takes to clear itself after a save. Matches the
 * `form-wipe` animation in styles.css; both are here rather than read from the
 * DOM because `animationend` does not reliably fire for a zero-length
 * animation, which is what reduced motion turns this into.
 */
const WIPE_MS = 380

type Phase =
  | { name: 'editing' }
  | { name: 'checking' }
  /** Something already stored looks like this posting; saving would add a copy. */
  | { name: 'duplicate'; match: DuplicateMatch }
  | { name: 'saving' }
  | { name: 'deleting' }
  | { name: 'wiping' }
  | { name: 'failed'; message: string }

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * A fill that has happened: what was filled, and from where.
 *
 * The draft is kept as well as the detection because it becomes the dirty
 * baseline. `isDirty` has compared against a baseline rather than against empty
 * since phase 3, for exactly this: after a fill, "the user has typed something"
 * has to mean "different from what was filled in", not "not blank" (decision
 * 13). Without it, Discard would light up on a form nobody had touched.
 */
interface Filled {
  detection: DetectionSummary
  draft: Draft
}

/**
 * What a fill is being asked to do about the record the form is holding.
 *
 * There is no default, and that is the point. `applyFill` used to take a base
 * draft and nothing else, so every caller silently kept whatever `draftId` was
 * loaded — including the callers reached while a stored record was open, which
 * is how a fill came to overwrite the record it was filling beside. A required
 * parameter is the cheapest way to make the question unskippable: a new caller
 * cannot compile without answering it.
 *
 * - `update` — the page describes the record that is open, so the fill lands on
 *   it. The id is kept.
 * - `new` — the page describes a different job, so the record is let go of
 *   first and the fill starts a record of its own.
 */
type FillIntent = 'update' | 'new'

export function PostingForm({
  onSaved,
  onDeleted,
  detection,
  editing,
  onStopEditing,
}: {
  onSaved: () => void
  /** A record was removed; the list and the badge both now claim something false. */
  onDeleted: () => void
  /** What the active tab is showing, or `null` if it is not a posting. */
  detection: DetectionSummary | null
  /**
   * A stored record the user asked to edit — a *request*, not the state.
   *
   * What the form has actually loaded is `edited` below, and the two are
   * deliberately separate for the same reason `offered` and `filled` are: a
   * request to take something new has to be refusable while the form is holding
   * work, and a prop cannot be refused.
   */
  editing: Posting | null
  /** The form is no longer holding a stored record — saved, discarded or deleted. */
  onStopEditing: () => void
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [phase, setPhase] = useState<Phase>({ name: 'editing' })
  const [showErrors, setShowErrors] = useState(false)
  const [filled, setFilled] = useState<Filled | null>(null)
  /**
   * The fill that would overwrite typed work and is waiting to be confirmed.
   *
   * The intent rather than a flag, because while a record is open there are two
   * fills on offer and confirming one must not arm the other.
   */
  const [confirmingFill, setConfirmingFill] = useState<FillIntent | null>(null)
  /** The detection whose banner has been folded away, by id. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  /** A record this page matches, found before anything was typed. */
  const [revisit, setRevisit] = useState<DuplicateMatch | null>(null)

  /**
   * The stored record the form is holding, and the draft it was loaded as.
   *
   * The draft half is the dirty baseline, exactly as `Filled` carries one: from
   * here on "the user has changed something" means "differs from the record as
   * stored", not "differs from blank". A record loaded and left alone is not
   * dirty, which is what makes Discard and the swap rule behave.
   */
  const [edited, setEdited] = useState<{ posting: Posting; draft: Draft } | null>(null)
  /** Set when opening a record would discard unsaved work, awaiting confirmation. */
  const [confirmingEdit, setConfirmingEdit] = useState<Posting | null>(null)
  /** Set when Delete has been pressed once. Destructive things ask twice. */
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  /**
   * Fixed for the life of this draft rather than generated at save.
   *
   * A save that is retried — after the duplicate prompt, or after a failure —
   * must reuse the id, or the retry writes a second record instead of being the
   * no-op the repository is built to make it. Editing is the same requirement
   * arriving from the other end: the id is the stored record's, and that is the
   * whole of what makes an edit an edit rather than a second record.
   */
  const [draftId, setDraftId] = useState(newId)

  const errors = draftErrors(draft)
  const dirty = isDirty(draft, filled?.draft ?? edited?.draft ?? EMPTY_DRAFT)

  /**
   * The form is holding a stored record, or is about to be.
   *
   * The second half is not belt-and-braces. The effect that loads a record and
   * the effect that swaps in a detection run in the same commit, so on the pass
   * where the record arrives `edited` is still `null` in the swap effect's
   * closure — it reads the state as it was rendered, not as the effect above it
   * has just set it. A record opened on a tab that is itself a posting was
   * therefore filled straight over before it had ever been seen: pristine, by
   * every test the swap rule applies, and still holding the stored record's id.
   *
   * The prop is the request and is available on the same render, so it closes
   * the gap the state cannot.
   */
  const holdingRecord = edited !== null || editing !== null

  /**
   * Whether there is anything to throw away.
   *
   * Not the same question as `dirty`, and conflating them broke Discard. After
   * a fill the draft *equals* its baseline, so `dirty` is false while the form
   * is full — leaving a user who filled from the wrong posting, which is what a
   * board that rendered late produces, to clear every field by hand. `dirty`
   * governs "has the user typed something worth protecting" (decision 13);
   * this governs "is the form empty", which is what Discard is asking.
   */
  const hasContent = dirty || filled !== null || edited !== null
  const busy =
    phase.name === 'checking' ||
    phase.name === 'saving' ||
    phase.name === 'deleting' ||
    phase.name === 'wiping'
  /**
   * The form is holding a question the user has not answered. See `swapAction`.
   *
   * A pending "open this other record?" belongs here for the same reason the
   * duplicate prompt does: a re-report from `watch-url.ts` — which polls every
   * second — must not refill the form and take the question away unanswered.
   */
  const prompting =
    phase.name === 'duplicate' || phase.name === 'failed' || confirmingEdit !== null

  /**
   * A detection worth offering: one that is not already in the form.
   *
   * Comparing on `detectionId` rather than on the URL means a re-read of the
   * same page — which the content script does when a single-page board renders
   * late — offers itself again with the better parse, while a page that has not
   * changed does not nag.
   */
  const offered =
    detection && detection.detectionId !== filled?.detection.detectionId ? detection : null

  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    // A failed or superseded attempt should not keep shouting while the user is
    // fixing it.
    if (phase.name === 'duplicate' || phase.name === 'failed') setPhase({ name: 'editing' })
  }

  /**
   * Empties the form and keeps it empty.
   *
   * `dismissed` is set to the current detection rather than cleared, and that is
   * the whole reason Discard works at all now that the form fills itself.
   * Clearing it dropped the only suppressor there is: on the very next render
   * `filled` is `null`, so the page is `offered` again, and a form that is empty
   * is by definition not `dirty` — so the swap effect below fills it straight
   * back in. The fields blanked for one frame and repopulated, and no reachable
   * state kept a posting tab's form empty. That is the failure the decision 13
   * amendment was written to fix, arriving by a new route.
   *
   * The page is not forgotten, only folded away: `DetectedNotice` still renders
   * as a one-line "Fill from this page", so a discard the user regrets costs one
   * click. And after a save it is the better banner anyway — the tab is tracked
   * by then, so a full-height offer to file it again is not what that moment
   * calls for.
   */
  /**
   * Lets go of the stored record, so that what happens next writes beside it
   * rather than over it.
   *
   * **This is the one place where `draftId` stops being the stored record's**,
   * which is the whole of the invariant: the id is what makes an edit an edit,
   * so an edit ends here or it does not end. `reset` used to own that sentence
   * and be wrong about it — `applyFill` was a fourth exit from editing that
   * never came through, and the next save wrote the page it had just read over
   * the record still held. Not a lost draft: a destroyed record.
   *
   * `onStopEditing` matters as much as the id. Without it the panel still holds
   * the request, and the effect below hands the same record straight back into
   * the form the user has just walked away from.
   *
   * Called unconditionally rather than guarded on `edited`, by callers that
   * sometimes hold nothing. That is deliberate: with no record held, minting an
   * id is what a fresh draft wants anyway and `onStopEditing` is a no-op. A
   * guard here would only create a second answer to "did the id move", which is
   * the question this function exists to have exactly one of.
   */
  const releaseRecord = () => {
    setDraftId(newId())
    setEdited(null)
    // The record it was armed against is no longer the one in the form.
    setConfirmingDelete(false)
    onStopEditing()
  }

  const reset = () => {
    setDraft(EMPTY_DRAFT)
    setShowErrors(false)
    setPhase({ name: 'editing' })
    setFilled(null)
    setConfirmingFill(null)
    setDismissed(detection?.detectionId ?? null)
    setConfirmingEdit(null)
    // Every exit from editing goes through here — saved, discarded, deleted —
    // and through `applyFill`'s `new` branch, which is the one it used to miss.
    releaseRecord()
  }

  /** Loads a stored record into the form, under its own id. */
  const openForEdit = (posting: Posting) => {
    const next = draftFromPosting(posting)
    setDraft(next)
    setDraftId(posting.id)
    setEdited({ posting, draft: next })
    setShowErrors(false)
    setPhase({ name: 'editing' })
    // A record arriving replaces a fill, and must not leave its provenance
    // behind: `save` prefers `filled` over `edited`, so a stale one here would
    // stamp this record with the last detected page's adapter.
    setFilled(null)
    setConfirmingFill(null)
    setConfirmingEdit(null)
    setConfirmingDelete(false)
  }

  /**
   * Takes the record the panel is asking the form to open.
   *
   * Refuses while the form holds unsaved work, which is decision 13's rule
   * reaching the one surface that had no way to obey it. `hasContent` rather
   * than `dirty`: a form filled from a page and left alone is not dirty, but
   * throwing it away silently to open something else is still the small betrayal
   * the rule exists to prevent.
   */
  useEffect(() => {
    // Deferred rather than dropped while a save or a delete is in flight: the
    // draft has already been snapshotted for writing, and `busy` is a dependency
    // so the request is taken up the moment the write settles.
    if (busy || !editing || editing.id === edited?.posting.id) return

    if (hasContent) {
      setConfirmingEdit(editing)
      return
    }

    openForEdit(editing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, busy])

  /**
   * Applies a detection to the form.
   *
   * `base` is what the fill layers onto, and the callers want different things
   * from it.
   *
   * An explicit click layers onto the **current draft**, so status, notes, tags
   * and the applied date — none of which a job board knows anything about —
   * survive a fill. That is "answer what this page knows about the record I am
   * working on". See `fill.ts`.
   *
   * An automatic swap layers onto an **empty draft**, because it is a different
   * request: the user tabbed to another posting and the form should show that
   * posting. Layering a swap over the last one would leave the previous
   * posting's location or salary sitting under the new one wherever the new
   * page happened to be quieter — a record that is a blend of two jobs and
   * looks like neither.
   *
   * `intent` is the record half of the same question, and it is required
   * because the answer used to be assumed. Every fill meets here, so this is
   * where the id is let go of — guarding the destination rather than the routes,
   * since it was a second route to the hazard that produced the bug this
   * parameter exists to close.
   */
  const applyFill = (summary: DetectionSummary, base: Draft, intent: FillIntent) => {
    // Before the fill, not after: `save` reads `edited` for provenance and for
    // the duplicate check, and both have to see a form that has let go.
    if (intent === 'new') releaseRecord()

    const next = draftFromDetection(summary, base)
    setDraft(next)
    setFilled({ detection: summary, draft: next })
    setConfirmingFill(null)
    if (phase.name === 'duplicate' || phase.name === 'failed') setPhase({ name: 'editing' })
  }

  /**
   * A fill the user asked for, in whichever of its two meanings they asked for.
   *
   * The confirm step is decision 13's: "fill from this page" is not the same
   * request as "throw away what I wrote", so a form with typed work in it asks
   * first. Keyed on the intent so that arming one of the two buttons does not
   * arm the other — pressing Update once and then changing your mind and
   * pressing "new record" should ask again, about the thing it is now about to
   * do.
   *
   * The base each intent takes is the part worth reading twice:
   *
   * - **`update` always layers onto the current draft, confirmed or not.** The
   *   confirmed path elsewhere replaces from empty, and doing that here would
   *   blank the record's own notes, tags, stage and outcome — none of which the
   *   page has any answer for — and then write that emptiness over the record.
   *   A confirmation to replace typed *fields* is not permission to erase the
   *   half of a record a job board has never heard of.
   * - **`new` layers onto an empty draft whenever a record is open**, because
   *   "this is a different job" is exactly the claim being made by pressing it.
   *   Carrying the record's location or salary into the new one under a heading
   *   naming a different company is the blend `applyFill` describes above.
   * - With no record open, `new` keeps today's rule: confirmed replaces from
   *   empty, unconfirmed layers onto the draft, because there the draft *is*
   *   the thing the user is working on.
   */
  const requestFill = (summary: DetectionSummary, intent: FillIntent) => {
    if (dirty && confirmingFill !== intent) {
      setConfirmingFill(intent)
      return
    }

    const replacing = edited !== null || confirmingFill === intent
    applyFill(summary, intent === 'new' && replacing ? EMPTY_DRAFT : draft, intent)
  }

  /**
   * Decision 13's swap rule, now that the panel follows the tab.
   *
   * A pristine form takes the new posting without being asked; a form with
   * typed work in it falls through to the banner below and waits. "Pristine"
   * is `dirty`, not "empty" — a form auto-filled from the last posting and left
   * alone is still untouched, and that is precisely the case that has to swap,
   * because it is what tabbing between two postings looks like.
   *
   * Locked while a save is in flight for the same reason every other way into
   * the form is: `toPostingInput` has already snapshotted the draft, so a fill
   * landing in the gap is written as the pre-fill values and then wiped by the
   * reset that follows.
   */
  useEffect(() => {
    const action = swapAction({
      offered: offered !== null,
      dirty,
      busy,
      prompting,
      editing: holdingRecord,
      dismissed: dismissed === offered?.detectionId,
    })

    // `announce` and `nothing` are both "leave the form alone" here — the
    // banner below renders from `offered` on its own.
    //
    // `new` is the only honest answer: `swapAction` returns `announce` whenever
    // a record is held, so a swap that reaches here is holding none, and the
    // release it performs is a fresh id for a form that wanted one anyway.
    if (action === 'fill' && offered) applyFill(offered, EMPTY_DRAFT, 'new')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered?.detectionId, busy, dirty, prompting, dismissed, holdingRecord])

  /**
   * The revisit warning: "have I been here before", asked on arrival.
   *
   * The same `findDuplicate` the save path uses, run at the point the question
   * is actually being asked rather than after the description has been read and
   * the notes typed (decision 7). Answering it at save is answering it too late.
   *
   * Keyed on the detection rather than on the draft on purpose. This is a
   * question about the *page*, so it must not re-run on every keystroke, and it
   * must not depend on the user having filled anything in.
   */
  const latestRevisit = useRef(0)

  useEffect(() => {
    const mine = ++latestRevisit.current

    /**
     * Cleared before the question is re-asked, not after it is re-answered.
     *
     * This banner asserts something about *this* page, so the instant the page
     * changes the old answer is false — and it was surviving the change twice
     * over. For the length of the round trip, which on a cold worker is the
     * better part of a second, it claimed the previous posting's company and
     * date about the new one. Worse, if the lookup then failed, the `catch`
     * below deliberately does nothing, so the wrong claim simply stayed on
     * screen with nothing left in flight to replace it.
     *
     * A success writes the new answer over this, and it costs no flicker: the
     * dependency is the detection id, so re-reading the same page does not
     * re-run the effect.
     */
    setRevisit(null)

    if (!detection) return

    void (async () => {
      try {
        const match = await send('posting/find-duplicate', {
          posting: postingInputFromDetection(detection),
        })
        // Same race as the detection fetch upstream: tabbing quickly leaves two
        // of these in flight, and the older one must not win.
        if (mine === latestRevisit.current) setRevisit(match)
      } catch (error) {
        // Not knowing is the same as not matching, and the panel already
        // reports a worker it cannot reach. A second banner about it here
        // would be noise on top of noise.
        console.debug('[JourneyTracker] could not check for a revisit', error)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection?.detectionId])

  // The wipe is driven by a timer rather than `animationend`, so a form that is
  // not animating at all still clears.
  useEffect(() => {
    if (phase.name !== 'wiping') return

    const timer = setTimeout(reset, prefersReducedMotion() ? 0 : WIPE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.name])

  async function save(force: boolean) {
    if (!isSaveable(draft)) {
      setShowErrors(true)
      return
    }

    // Provenance travels with the save rather than being stamped on later: a
    // record that came off a page has to say which adapter read it, or a fix to
    // that adapter has no way to find the records it should replay (decision 6).
    //
    // The edit case is the one that would have lost it silently. Falling through
    // to `MANUAL_SAVE` here would restamp a record `manual@1` the first time
    // anybody corrected a typo in it — see `editContextFor`. A fill still wins,
    // because a page just read from is a better answer than what the record said
    // when it was written.
    const posting = toPostingInput(
      draft,
      draftId,
      filled
        ? saveContextFor(filled.detection, draft)
        : edited
          ? editContextFor(edited.posting, draft)
          : MANUAL_SAVE,
    )

    try {
      // Skipped when editing, because the check exists to stop a *second* record
      // being written and an edit writes none — it goes to the same id. The
      // repository already declines to match a record against itself, so this
      // could only surface an unrelated posting, under copy ("You already saved
      // this one · Discard this / Save anyway") that is nonsense when the thing
      // you already saved is the thing you are editing.
      if (!force && !edited) {
        setPhase({ name: 'checking' })
        const match = await send('posting/find-duplicate', { posting })
        if (match) {
          setPhase({ name: 'duplicate', match })
          return
        }
      }

      setPhase({ name: 'saving' })
      // The id, not the snapshot: the worker has the page source cached and the
      // panel never needs to hold 256KB of it. See `lib/detection.ts`.
      await send('posting/upsert', {
        posting,
        detectionId: filled?.detection.detectionId,
      })
      onSaved()
      setPhase({ name: 'wiping' })
    } catch (error) {
      console.error('[JourneyTracker] save failed', error)
      setPhase({
        name: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Removes the record being edited.
   *
   * Reachable only from edit mode, because there is nothing else to delete — a
   * draft that has never been saved is discarded, not deleted, and the two
   * buttons say so.
   *
   * The id is taken before the round trip and used after it rather than being
   * re-read from state, so a record opened in the gap cannot be the one that
   * gets reported as deleted.
   */
  async function remove() {
    if (!edited) return
    const { id } = edited.posting

    setPhase({ name: 'deleting' })

    try {
      await send('posting/delete', { id })

      /**
       * The revisit banner, cleared here because nothing else can.
       *
       * It is hidden while a record is open for editing, so this looks like it
       * needs no attention — and then `reset()` clears `edited` and it comes
       * straight back, naming the record that has just been deleted, with its
       * dates. The effect that owns `revisit` is keyed on the detection id, and
       * a delete does not change what the tab is showing: `detection/get` reads
       * a cache that only a content script's report ever writes. So the effect
       * never re-runs and the stale answer survives until the tab navigates.
       *
       * Exactly the badge defect, in a sibling banner, missed by the same
       * reasoning — twice now the panel has been credited with re-checking
       * something that `refreshDetection` cannot re-check.
       *
       * Only when it names *this* record. A banner about some other posting the
       * page also matches is still true, and clearing it would trade a false
       * claim for a missing one.
       */
      setRevisit((current) => (current?.posting.id === id ? null : current))

      // Before `reset`, which clears the record this was about. This refreshes
      // the list and, through it, the counts. The toolbar badge is repainted by
      // the worker inside `posting/delete`, because it is the only context that
      // can reach `chrome.action`.
      onDeleted()
      reset()
    } catch (error) {
      console.error('[JourneyTracker] delete failed', error)
      setPhase({
        name: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
      setConfirmingDelete(false)
    }
  }

  return (
    <form
      className={`form${phase.name === 'wiping' ? ' form--wiping' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
      noValidate
    >
      {/* Says which record the fields belong to, because otherwise nothing
          does: a form full of a stored posting looks exactly like a form full
          of a new one, and the difference is whether Save writes a record or
          overwrites one. */}
      {edited && (
        <p className="notice notice--editing" role="status">
          <span className="notice__title">Editing a saved posting.</span>{' '}
          <span className="notice__detail">
            Saved {new Date(edited.posting.createdAt).toLocaleDateString()} · saving updates
            it rather than adding another.
          </span>
        </p>
      )}

      {confirmingEdit && (
        <div className="notice" role="alert">
          <p className="notice__title">Open a different posting?</p>
          <p>
            {confirmingEdit.company} — {confirmingEdit.jobTitle}
          </p>
          <p className="notice__detail">
            {edited
              ? 'Your unsaved changes to the current one would be lost.'
              : 'What is in the form now would be lost.'}
          </p>
          <div className="notice__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                // The request is refused rather than parked. Left pending, the
                // effect above would re-raise it on the next thing that moved,
                // and a question the user has answered must stay answered.
                setConfirmingEdit(null)
                onStopEditing()
              }}
            >
              Keep what I have
            </button>
            <button
              type="button"
              className="button"
              onClick={() => openForEdit(confirmingEdit)}
            >
              Open it
            </button>
          </div>
        </div>
      )}

      {/* Suppressed while the save-time prompt is up: they are the same finding
          at two different moments, and showing both would ask the user to
          reconcile two banners about one record. Suppressed while editing for a
          different reason — it is a statement about the active tab, and next to
          a form holding some other record it reads as a claim about that
          record. */}
      {revisit && phase.name !== 'duplicate' && !edited && (
        <RevisitNotice match={revisit} />
      )}

      {offered && (
        <DetectedNotice
          detection={offered}
          changes={fieldsFilled(offered, draft).length}
          confirming={confirmingFill}
          quiet={dismissed === offered.detectionId}
          // Locked for the same reason the fieldset below is, and it was
          // outside it: a fill landing during a save writes into `draft` and
          // `filled` after `toPostingInput` has already snapshotted the draft,
          // so the record is written with the pre-fill values and manual
          // provenance — and then `reset()` wipes the fill on the way out.
          // Every way into the form has to be shut while a save is in flight,
          // not just the inputs.
          busy={busy}
          // The record the fill would land on, or `null` when the form is
          // holding none. Naming it in the notice is half the fix: nothing on
          // this screen used to say that "Fill form" was aimed at a stored
          // record, so the destructive reading of the button was also the
          // invisible one.
          record={edited?.posting ?? null}
          onUpdate={() => requestFill(offered, 'update')}
          onFillNew={() => requestFill(offered, 'new')}
          onDismiss={() => {
            // Folds the banner down to a one-line offer rather than removing
            // it. Decision 13 is explicit that dismissing must not discard the
            // detection silently, and a button that has quietly stopped
            // existing is not something a user can ask for again.
            setDismissed(offered.detectionId)
            setConfirmingFill(null)
          }}
        />
      )}

      {/*
        Locked while a save is in flight. `toPostingInput` snapshots the draft
        before the round-trip, and on a cold worker that round-trip is not
        instant — the client retries a waking worker four times. Without this,
        a correction typed into the gap would be checked against the old values,
        written as the old values, and then wiped by the reset that follows.
      */}
      <fieldset className="fields" disabled={busy}>
        <Text
          label="Company"
          value={draft.company}
          onChange={(v) => field('company', v)}
          error={showErrors ? errors.company : undefined}
          required
          autoFocus
        />

        <Text
          label="Job title"
          value={draft.jobTitle}
          onChange={(v) => field('jobTitle', v)}
          error={showErrors ? errors.jobTitle : undefined}
          required
        />

        <Text
          label="Posting URL"
          type="url"
          value={draft.url}
          onChange={(v) => field('url', v)}
          hint="Optional. Used to recognise this posting again."
        />

        <div className="row">
          <Text
            label="Location"
            value={draft.location}
            onChange={(v) => field('location', v)}
          />
          <Select
            label="Work mode"
            value={draft.workMode}
            onChange={(v) => field('workMode', v as Draft['workMode'])}
            options={[
              ['', '—'],
              ['onsite', 'Onsite'],
              ['hybrid', 'Hybrid'],
              ['remote', 'Remote'],
            ]}
          />
        </div>

        <div className="row">
          <Text
            label="Salary"
            value={draft.salary}
            onChange={(v) => field('salary', v)}
            hint="As written"
          />
          <Text
            label="Req ID"
            value={draft.atsReqId}
            onChange={(v) => field('atsReqId', v)}
          />
        </div>

        <div className="row">
          <Select
            label="Status"
            value={draft.state}
            onChange={(v) => {
              field('state', v as Draft['state'])
              // Applying is nearly always something you just did.
              if (v === 'applied' && !draft.appliedAt) field('appliedAt', today())
            }}
            options={[
              ['viewed', 'Viewed'],
              ['applied', 'Applied'],
            ]}
          />
          {draft.state === 'applied' && (
            <Text
              label="Applied on"
              type="date"
              value={draft.appliedAt}
              onChange={(v) => field('appliedAt', v)}
            />
          )}
        </div>

        {/*
          What happened after, on the two axes phase 8 added. Only shown once
          the status is `applied`, because neither means anything about a
          posting that was merely looked at — and the repository strips them
          from one regardless, so a hidden control cannot leave a stale claim
          on the record.

          Both default to the blank option and both are meant to stay there for
          a while: no stage is "nothing heard yet" and no outcome is "still
          open", which is the ordinary state of a recent application rather
          than an unanswered question. Neither is labelled "none", which would
          read as a thing to go and fix.
        */}
        {draft.state === 'applied' && (
          <div className="row">
            <Select
              label="Furthest stage"
              value={draft.stage}
              // Locked, not merely mirrored, while the outcome is `accepted`.
              // The mirror below used to run in one direction only, so choosing
              // Accepted and then correcting the stage down to Screening left
              // the form reading Screening/Accepted while `resolveProgress`
              // stored Offer/Accepted — the form disagreeing with the record,
              // which is the exact thing the mirror was added to prevent.
              // Disabling says why the control will not move; silently
              // snapping it back would not.
              disabled={draft.outcome === 'accepted'}
              hint={
                draft.outcome === 'accepted' ? 'An accepted offer implies one.' : undefined
              }
              onChange={(v) => field('stage', v as Draft['stage'])}
              options={[
                ['', 'Nothing heard yet'],
                ['screening', 'Screening'],
                ['interviewing', 'Interviewing'],
                ['offer', 'Offer'],
              ]}
            />
            <Select
              label="Outcome"
              value={draft.outcome}
              onChange={(v) => {
                const outcome = v as Draft['outcome']
                field('outcome', outcome)
                // An offer is implied by accepting one. The repository enforces
                // this anyway (`resolveProgress`), but doing it here as well is
                // what stops the form showing "Nothing heard yet" next to
                // "Accepted" in the moment before a save.
                if (outcome === 'accepted' && draft.stage !== 'offer') {
                  field('stage', 'offer')
                }
              }}
              options={[
                ['', 'Still open'],
                ['rejected', 'Rejected'],
                ['withdrawn', 'Withdrawn'],
                ['accepted', 'Accepted'],
              ]}
            />
          </div>
        )}

        <Text
          label="Resume used"
          value={draft.resumeUsed}
          onChange={(v) => field('resumeUsed', v)}
          hint="A label, e.g. “backend-2026”. No file is stored."
        />

        <Text
          label="Tags"
          value={draft.tags}
          onChange={(v) => field('tags', v)}
          hint="Comma separated"
        />

        <Textarea label="Notes" value={draft.notes} onChange={(v) => field('notes', v)} />
      </fieldset>

      {phase.name === 'duplicate' && (
        <DuplicateNotice
          match={phase.match}
          onDiscard={reset}
          onSaveAnyway={() => void save(true)}
        />
      )}

      {phase.name === 'failed' && (
        <p className="notice notice--bad" role="alert">
          Could not save — {phase.message}
        </p>
      )}

      {/*
        Only in edit mode, because only then is there something to delete: an
        unsaved draft is discarded, and offering "Delete" for it would be
        offering to remove a record that does not exist.

        Two presses, like the erase in `BackupSection`. The second button says
        what it will do to which record rather than "Confirm", so a stray click
        cannot destroy a posting on the strength of a word that could mean
        anything.
      */}
      {edited && (
        <div className="form__danger">
          {confirmingDelete ? (
            <>
              <p className="notice__detail">
                Delete {edited.posting.company} — {edited.posting.jobTitle}? This cannot be
                undone.
              </p>
              <div className="notice__actions">
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void remove()}
                  disabled={busy}
                >
                  {phase.name === 'deleting' ? 'Deleting…' : 'Delete it'}
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              Delete this posting
            </button>
          )}
        </div>
      )}

      <div className="form__actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={reset}
          disabled={!hasContent || busy}
        >
          {/* Discarding a draft throws work away; leaving an edit throws
              nothing away, because the record is already stored. Same button,
              two honest descriptions of what it does. */}
          {edited ? (dirty ? 'Discard changes' : 'Stop editing') : 'Discard'}
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          {phase.name === 'checking' || phase.name === 'saving'
            ? 'Saving…'
            : edited
              ? 'Save changes'
              : 'Save'}
        </button>
      </div>
    </form>
  )
}

/**
 * Offers what the page said, and shows enough of it to be judged.
 *
 * It names the fields it would fill and the adapter that read them rather than
 * just claiming a posting was found. A user who can see "company, job title,
 * location · greenhouse" before clicking does not have to undo anything to find
 * out what the button does — which matters because the tiers genuinely differ in
 * quality, and a `generic` read off a link preview deserves more suspicion than
 * a board's own state blob.
 *
 * The confidence number is deliberately not shown. It is coverage weighted by
 * trust, not a probability that the parse is right (see `extract/merge.ts`), and
 * a percentage in a UI is read as the second thing no matter what the tooltip
 * says.
 */
function DetectedNotice({
  detection,
  changes,
  confirming,
  quiet,
  busy,
  record,
  onUpdate,
  onFillNew,
  onDismiss,
}: {
  detection: DetectionSummary
  changes: number
  confirming: FillIntent | null
  quiet: boolean
  busy: boolean
  /**
   * The stored record the form is holding, if it is holding one.
   *
   * Its presence is what splits one button into two. With no record open there
   * is only one thing a fill can mean and asking would be noise; with one open
   * there are two, they differ by which record gets written, and the difference
   * is invisible from the page.
   */
  record: Posting | null
  onUpdate: () => void
  onFillNew: () => void
  onDismiss: () => void
}) {
  const { company, jobTitle } = detection.fields
  const heading = [jobTitle, company].filter(Boolean).join(' · ')
  const held = record && [record.company, record.jobTitle].filter(Boolean).join(' · ')

  if (quiet) {
    return (
      <p className="detected detected--quiet">
        {/* The confirm step has to be visible here too. Dismissed, the banner
            is a button or two and nothing else, and asking for confirmation by
            flipping a state nothing renders made the first click look like a
            dead button — the fill only happened on the second, for no reason
            the user could see. */}
        {record ? (
          <>
            <button
              type="button"
              className="button button--quiet"
              onClick={onUpdate}
              disabled={busy}
            >
              {confirming === 'update' ? 'Overwrite what you typed?' : 'Update this record'}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={onFillNew}
              disabled={busy}
            >
              {confirming === 'new' ? 'Discard what you typed?' : 'Save as a new record'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button--quiet"
            onClick={onFillNew}
            disabled={busy}
          >
            {confirming ? 'Replace what you typed?' : 'Fill from this page'}
          </button>
        )}
      </p>
    )
  }

  return (
    <div className="notice detected" role="status">
      <p className="notice__title">
        {confirming ? 'Replace what you have typed?' : 'This page looks like a posting.'}
      </p>
      <p>{heading}</p>
      <p className="notice__detail">
        {changes === 0
          ? 'Nothing new to fill in'
          : `Would fill ${changes} field${changes === 1 ? '' : 's'}`}
        {` · read by ${detection.source}`}
        {detection.snapshotBytes > 0 && ' · page kept for re-parsing'}
      </p>
      {/* The sentence the old single button did not have room to say. A user
          who can read which record is open before choosing does not have to
          discover the answer by losing it. */}
      {held && (
        <p className="notice__detail">
          You have {held} open. Updating writes this page onto it; a new record leaves it as
          it is.
        </p>
      )}
      <div className="notice__actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={onDismiss}
          disabled={busy}
        >
          Not now
        </button>
        {record && (
          <button
            type="button"
            className="button button--quiet"
            onClick={onFillNew}
            // Never gated on `changes`, which counts against the record in the
            // form. A page identical to the record still supports "this is a
            // separate application" — and if it is not, the duplicate check
            // that this path re-arms is the thing that says so.
            disabled={busy}
          >
            {confirming === 'new' ? 'Discard and start a new one' : 'Save as a new record'}
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={record ? onUpdate : onFillNew}
          disabled={busy || (changes === 0 && confirming === null)}
        >
          {record
            ? confirming === 'update'
              ? 'Overwrite this record'
              : 'Update this record'
            : confirming
              ? 'Replace'
              : 'Fill form'}
        </button>
      </div>
    </div>
  )
}

/**
 * "You have been here before" — said on arrival, not at save.
 *
 * Deliberately not a prompt. Nothing has been typed yet, so there is no
 * decision to make and nothing to confirm or discard; the useful thing is the
 * fact and the date, delivered before the user spends ten minutes re-reading a
 * description they already read. Giving it buttons would turn an answer into a
 * question.
 *
 * It states the previous outcome because that is the part people actually want:
 * "applied" means do not bother, "viewed" means this is the second time this
 * page has caught your eye and perhaps that means something.
 */
function RevisitNotice({ match }: { match: DuplicateMatch }) {
  const { posting } = match
  const applied = posting.state === 'applied' && posting.appliedAt !== null

  return (
    <div className="notice notice--revisit" role="status">
      <p className="notice__title">
        {applied
          ? `You applied to this on ${formatDay(posting.appliedAt)}.`
          : `You looked at this on ${formatDay(posting.createdAt)}.`}
      </p>
      <p className="notice__detail">
        {posting.company} — {posting.jobTitle}
        {/* A title match is a resemblance, not identity (decision 7), so it
            says so rather than asserting you were on this exact page. */}
        {match.matchedOn === 'title' &&
          ' · matched on the title, so possibly a different one'}
      </p>
    </div>
  )
}

function formatDay(at: number | null): string {
  return at === null ? 'an earlier date' : new Date(at).toLocaleDateString()
}

/**
 * Says which key matched rather than asserting a duplicate flatly.
 *
 * A URL or requisition match is identity and can be stated as fact. A title
 * match is a resemblance — the same employer hiring for the same role twice is
 * ordinary — so it asks instead, and shows enough of the stored record that the
 * question can be answered by looking rather than by guessing.
 */
function DuplicateNotice({
  match,
  onDiscard,
  onSaveAnyway,
}: {
  match: DuplicateMatch
  onDiscard: () => void
  onSaveAnyway: () => void
}) {
  const certain = match.matchedOn !== 'title'
  const { posting } = match

  return (
    <div className="notice" role="alert">
      <p className="notice__title">
        {certain ? 'You already saved this one.' : 'This looks like one you already saved.'}
      </p>
      <p>
        {posting.company} — {posting.jobTitle}
      </p>
      <p className="notice__detail">
        {posting.state === 'applied' && posting.appliedAt
          ? `Applied ${new Date(posting.appliedAt).toLocaleDateString()}`
          : `Saved ${new Date(posting.createdAt).toLocaleDateString()}`}
        {posting.canonicalUrl && ` · ${hostOf(posting.canonicalUrl)}`}
        {match.matchedOn === 'requisition' &&
          posting.atsReqId &&
          ` · req ${posting.atsReqId}`}
      </p>
      <div className="notice__actions">
        <button type="button" className="button button--quiet" onClick={onDiscard}>
          Discard this
        </button>
        <button type="button" className="button" onClick={onSaveAnyway}>
          {certain ? 'Save anyway' : 'Save as separate'}
        </button>
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function Text({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  required,
  autoFocus,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  hint?: string
  error?: string
  required?: boolean
  autoFocus?: boolean
}) {
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <p className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        className="field__input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
      />
      {error ? (
        <span className="field__error" id={`${id}-error`}>
          {error}
        </span>
      ) : (
        hint && (
          <span className="field__hint" id={`${id}-hint`}>
            {hint}
          </span>
        )
      )}
    </p>
  )
}

function Textarea({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const id = useId()

  return (
    <p className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="field__input field__input--area"
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </p>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
  disabled,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: [value: string, label: string][]
  disabled?: boolean
  /** Why the control reads as it does — shown in place of nothing, not an error. */
  hint?: string
}) {
  const id = useId()
  const rendered = useMemo(() => options, [options])

  return (
    <p className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field__input"
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {rendered.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      {hint && (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </p>
  )
}
