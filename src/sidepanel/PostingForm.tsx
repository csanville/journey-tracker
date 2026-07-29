import { useEffect, useId, useMemo, useState } from 'react'
import { send } from '../lib/client'
import type { DetectionSummary } from '../lib/detection'
import { newId } from '../lib/ids'
import type { DuplicateMatch } from '../lib/types'
import {
  EMPTY_DRAFT,
  MANUAL_SAVE,
  draftErrors,
  isDirty,
  isSaveable,
  toPostingInput,
  today,
  type Draft,
} from './draft'
import { draftFromDetection, fieldsFilled, saveContextFor } from './fill'

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

export function PostingForm({
  onSaved,
  detection,
}: {
  onSaved: () => void
  /** What the active tab is showing, or `null` if it is not a posting. */
  detection: DetectionSummary | null
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [phase, setPhase] = useState<Phase>({ name: 'editing' })
  const [showErrors, setShowErrors] = useState(false)
  const [filled, setFilled] = useState<Filled | null>(null)
  /** Set when a fill would overwrite typed work and is waiting to be confirmed. */
  const [confirmingFill, setConfirmingFill] = useState(false)
  /** The detection whose banner has been folded away, by id. */
  const [dismissed, setDismissed] = useState<string | null>(null)

  /**
   * Fixed for the life of this draft rather than generated at save.
   *
   * A save that is retried — after the duplicate prompt, or after a failure —
   * must reuse the id, or the retry writes a second record instead of being the
   * no-op the repository is built to make it.
   */
  const [draftId, setDraftId] = useState(newId)

  const errors = draftErrors(draft)
  const dirty = isDirty(draft, filled?.draft ?? EMPTY_DRAFT)

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
  const hasContent = dirty || filled !== null
  const busy =
    phase.name === 'checking' || phase.name === 'saving' || phase.name === 'wiping'

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

  const reset = () => {
    setDraft(EMPTY_DRAFT)
    setDraftId(newId())
    setShowErrors(false)
    setPhase({ name: 'editing' })
    setFilled(null)
    setConfirmingFill(false)
    setDismissed(null)
  }

  /**
   * Applies a detection to the form.
   *
   * Layered over the current draft rather than replacing it, so status, notes,
   * tags and the applied date — none of which a job board knows anything about —
   * survive a fill. See `fill.ts`.
   */
  const applyFill = (summary: DetectionSummary) => {
    const next = draftFromDetection(summary, draft)
    setDraft(next)
    setFilled({ detection: summary, draft: next })
    setConfirmingFill(false)
    if (phase.name === 'duplicate' || phase.name === 'failed') setPhase({ name: 'editing' })
  }

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
    const posting = toPostingInput(
      draft,
      draftId,
      filled ? saveContextFor(filled.detection, draft) : MANUAL_SAVE,
    )

    try {
      if (!force) {
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

  return (
    <form
      className={`form${phase.name === 'wiping' ? ' form--wiping' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
      noValidate
    >
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
          onFill={() => {
            // Decision 13 in its explicit-click form. A pristine form fills
            // straight away; a form with typed work in it asks first, because
            // "fill from this page" is not the same request as "throw away what
            // I wrote". Live auto-fill, and the swap rules around it, are
            // phase 5.
            if (dirty && !confirmingFill) setConfirmingFill(true)
            else applyFill(offered)
          }}
          onDismiss={() => {
            // Folds the banner down to a one-line offer rather than removing
            // it. Decision 13 is explicit that dismissing must not discard the
            // detection silently, and a button that has quietly stopped
            // existing is not something a user can ask for again.
            setDismissed(offered.detectionId)
            setConfirmingFill(false)
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

      <div className="form__actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={reset}
          disabled={!hasContent || busy}
        >
          Discard
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          {phase.name === 'checking' || phase.name === 'saving' ? 'Saving…' : 'Save'}
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
  onFill,
  onDismiss,
}: {
  detection: DetectionSummary
  changes: number
  confirming: boolean
  quiet: boolean
  busy: boolean
  onFill: () => void
  onDismiss: () => void
}) {
  const { company, jobTitle } = detection.fields
  const heading = [jobTitle, company].filter(Boolean).join(' · ')

  if (quiet) {
    return (
      <p className="detected detected--quiet">
        <button
          type="button"
          className="button button--quiet"
          onClick={onFill}
          disabled={busy}
        >
          {/* The confirm step has to be visible here too. Dismissed, the
              banner is a single button, and asking for confirmation by
              flipping a state nothing renders made the first click look like a
              dead button — the fill only happened on the second, for no reason
              the user could see. */}
          {confirming ? 'Replace what you typed?' : 'Fill from this page'}
        </button>
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
      <div className="notice__actions">
        <button
          type="button"
          className="button button--quiet"
          onClick={onDismiss}
          disabled={busy}
        >
          Not now
        </button>
        <button
          type="button"
          className="button"
          onClick={onFill}
          disabled={busy || (changes === 0 && !confirming)}
        >
          {confirming ? 'Replace' : 'Fill form'}
        </button>
      </div>
    </div>
  )
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
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: [value: string, label: string][]
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
        onChange={(event) => onChange(event.target.value)}
      >
        {rendered.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </p>
  )
}
