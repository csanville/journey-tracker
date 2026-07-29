import { useEffect, useId, useMemo, useState } from 'react'
import { send } from '../lib/client'
import { newId } from '../lib/ids'
import type { DuplicateMatch } from '../lib/types'
import {
  EMPTY_DRAFT,
  draftErrors,
  isDirty,
  isSaveable,
  toPostingInput,
  today,
  type Draft,
} from './draft'

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

export function PostingForm({ onSaved }: { onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [phase, setPhase] = useState<Phase>({ name: 'editing' })
  const [showErrors, setShowErrors] = useState(false)

  /**
   * Fixed for the life of this draft rather than generated at save.
   *
   * A save that is retried — after the duplicate prompt, or after a failure —
   * must reuse the id, or the retry writes a second record instead of being the
   * no-op the repository is built to make it.
   */
  const [draftId, setDraftId] = useState(newId)

  const errors = draftErrors(draft)
  const dirty = isDirty(draft)
  const busy =
    phase.name === 'checking' || phase.name === 'saving' || phase.name === 'wiping'

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

    const posting = toPostingInput(draft, draftId)

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
      await send('posting/upsert', { posting })
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
          disabled={!dirty || busy}
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
