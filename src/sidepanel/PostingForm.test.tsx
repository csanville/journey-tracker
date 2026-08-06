// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DetectionSummary } from '../lib/detection'
import { handleRequest } from '../lib/handler'
import { JourneyTrackerDb } from '../lib/db'
import { upsertPosting } from '../lib/repository'
import type { Posting, PostingInput } from '../lib/types'
import { aPosting } from '../test/factories'
import { PostingForm } from './PostingForm'

/**
 * The edit path, exercised through the real message layer.
 *
 * `send` is pointed at `handleRequest` over a real (fake-indexeddb) database
 * rather than stubbed, because the claims worth testing here are claims about
 * what ends up stored: that an edit writes one record and not two, that it keeps
 * the provenance the record already had, and that nothing else can walk into the
 * form while it holds one. A stub would let all three pass while being false.
 *
 * The arithmetic and the pure rules live in `draft.test.ts` and `fill.test.ts`.
 * What this adds is the wiring between them, which is where phase 9's two
 * genuinely destructive failures would have lived.
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let db: JourneyTrackerDb
let root: Root | null = null
let host: HTMLDivElement | null = null
let counter = 0

beforeEach(async () => {
  db = new JourneyTrackerDb(`jt-form-${Date.now()}-${counter++}`)
  await db.open()
  // The panel's whole side of the protocol, answered by the worker's own
  // dispatcher. `handleRequest` already returns the `{ ok, data }` envelope
  // `send` unwraps, so nothing here has to imitate the shape.
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (request: unknown) =>
    handleRequest(db, request as never)) as never)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = null
  host = null
  db.close()
})

function stored(overrides: Partial<PostingInput> = {}): PostingInput {
  return { ...aPosting(), ...overrides }
}

interface Props {
  editing: Posting | null
  detection?: DetectionSummary | null
  onSaved?: () => void
  onDeleted?: () => void
  onStopEditing?: () => void
}

async function render(props: Props): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)

  await act(async () => {
    root = createRoot(host!)
    root.render(
      <PostingForm
        editing={props.editing}
        detection={props.detection ?? null}
        onSaved={props.onSaved ?? (() => {})}
        onDeleted={props.onDeleted ?? (() => {})}
        onStopEditing={props.onStopEditing ?? (() => {})}
      />,
    )
  })

  // The seeding effect and the revisit lookup both settle after the first paint.
  await settle()
  return host
}

/** Lets pending effects and their round trips through the handler finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

/** The control under a given visible label. */
function control(el: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const found = [...el.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.replace('*', '').trim() === label,
  )
  if (!found) throw new Error(`no control labelled ${label}`)

  return el.querySelector(`#${CSS.escape(found.htmlFor)}`) as
    HTMLInputElement | HTMLSelectElement
}

/**
 * Types into a controlled input the way React will notice.
 *
 * React installs its own `value` setter on the element, so assigning through it
 * updates the DOM without telling React anything. The prototype's setter is the
 * one that leaves React's tracker out of date, which is what makes the
 * subsequent event register as a real change.
 */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!

  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button labelled ${text}`)
  return found
}

async function submit(el: HTMLElement) {
  await act(async () => {
    el.querySelector('form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

describe('editing a stored record', () => {
  it('loads the record into the form', async () => {
    const posting = await upsertPosting(db, stored({ notes: 'referred by Dana' }))
    const el = await render({ editing: posting })

    expect((control(el, 'Company') as HTMLInputElement).value).toBe('Initech')
    expect((control(el, 'Job title') as HTMLInputElement).value).toBe('Staff Engineer')
    expect(el.textContent).toContain('Editing a saved posting')
  })

  /**
   * The phase gate, and the whole reason phase 9 exists. Phase 8 shipped `stage`
   * and `outcome` with no way to set them after the first save, so the response
   * funnel read "N still open" forever and recording a rejection meant entering
   * the job a second time — which double-counted it in the two funnels the
   * section exists to report.
   */
  it('records an outcome weeks later without writing a second record', async () => {
    const posting = await upsertPosting(
      db,
      stored({ state: 'applied', appliedAt: Date.now() }),
    )
    const el = await render({ editing: posting })

    await choose(control(el, 'Furthest stage') as HTMLSelectElement, 'interviewing')
    await choose(control(el, 'Outcome') as HTMLSelectElement, 'rejected')
    await submit(el)

    expect(await db.postings.count()).toBe(1)

    const saved = await db.postings.get(posting.id)
    expect(saved).toMatchObject({ stage: 'interviewing', outcome: 'rejected' })
  })

  it('keeps the id, so the edit lands on the record and not beside it', async () => {
    const posting = await upsertPosting(db, stored())
    const el = await render({ editing: posting })

    await type(control(el, 'Location') as HTMLInputElement, 'Remote (EU)')
    await submit(el)

    const saved = await db.postings.get(posting.id)
    expect(saved?.location).toBe('Remote (EU)')
    expect(await db.postings.count()).toBe(1)
  })

  it('does not re-date a record saved weeks ago', async () => {
    const posting = await upsertPosting(db, stored())
    const el = await render({ editing: posting })

    await type(control(el, 'Location') as HTMLInputElement, 'Austin')
    await submit(el)

    // `upsertPosting` prefers the stored `createdAt`, and an edit must not be
    // the thing that makes "newest first" stop meaning anything.
    expect((await db.postings.get(posting.id))?.createdAt).toBe(posting.createdAt)
  })

  /**
   * The silent-degradation trap. Without `editContextFor` the save falls through
   * to `MANUAL_SAVE` and restamps the record `manual@1` — losing the only thing
   * that says which records a later adapter fix should replay (decision 6), for
   * exactly the records that have a snapshot worth replaying.
   */
  it('keeps the provenance of a record that came off a page', async () => {
    const posting = await upsertPosting(
      db,
      stored({
        source: 'greenhouse',
        sourceConfidence: 0.9,
        adapterVersion: 'greenhouse@3',
      }),
    )
    const el = await render({ editing: posting })

    await type(control(el, 'Location') as HTMLInputElement, 'Austin, TX (hybrid)')
    await submit(el)

    expect(await db.postings.get(posting.id)).toMatchObject({
      source: 'greenhouse',
      adapterVersion: 'greenhouse@3',
    })
  })

  it('tells the panel when it lets go of the record', async () => {
    const posting = await upsertPosting(db, stored())
    const onStopEditing = vi.fn()
    const el = await render({ editing: posting, onStopEditing })

    await click(button(el, 'Stop editing'))

    expect(onStopEditing).toHaveBeenCalled()
    expect(el.textContent).not.toContain('Editing a saved posting')
  })
})

describe('a detection arriving while a record is open', () => {
  const detection: DetectionSummary = {
    detectionId: 'det-1',
    url: 'https://jobs.lever.co/other/00000000-0000-4000-8000-000000000000',
    source: 'lever',
    adapterVersion: 'lever@1',
    confidence: 0.71,
    capturedAt: 1000,
    snapshotBytes: 0,
    fields: {
      company: 'Some Other Company',
      jobTitle: 'Completely Different Role',
      location: 'Berlin',
      workMode: 'hybrid',
      atsReqId: null,
      salary: null,
    },
    provenance: {
      company: 'jsonld',
      jobTitle: 'jsonld',
      location: 'jsonld',
      workMode: 'dom',
      atsReqId: null,
      salary: null,
    },
  }

  /**
   * The failure that would have destroyed a record rather than a draft.
   *
   * A record just loaded equals its own baseline, so it is pristine by every
   * test the swap rule applies — and pristine is the state that fills. Without
   * the `editing` guard the form repopulates from whatever tab the user glanced
   * at *while still holding the stored record's id*, and the next save writes
   * that other job over the record being edited.
   */
  it('never overwrites the form, however untouched the record looks', async () => {
    const posting = await upsertPosting(db, stored())
    const el = await render({ editing: posting, detection })

    expect((control(el, 'Company') as HTMLInputElement).value).toBe('Initech')
    expect((control(el, 'Job title') as HTMLInputElement).value).toBe('Staff Engineer')
  })

  it('still offers the page, so a deliberate re-read is possible', async () => {
    const posting = await upsertPosting(db, stored())
    const el = await render({ editing: posting, detection })

    // Offer, never take. Suppressing the banner outright would make re-reading a
    // posting whose description changed impossible from the one screen that
    // holds the record.
    expect(el.textContent).toContain('This page looks like a posting')
  })

  it('saves the record, not the page, when the offer is left alone', async () => {
    const posting = await upsertPosting(db, stored())
    const el = await render({ editing: posting, detection })

    await submit(el)

    expect(await db.postings.count()).toBe(1)
    expect(await db.postings.get(posting.id)).toMatchObject({ company: 'Initech' })
  })
})

describe('deleting the record being edited', () => {
  it('asks before removing anything', async () => {
    const posting = await upsertPosting(db, stored())
    const el = await render({ editing: posting })

    await click(button(el, 'Delete this posting'))

    // One press arms it and removes nothing.
    expect(await db.postings.count()).toBe(1)
    expect(el.textContent).toContain('This cannot be undone')
  })

  it('removes the record once confirmed, and says so upward', async () => {
    const posting = await upsertPosting(db, stored())
    const onDeleted = vi.fn()
    const el = await render({ editing: posting, onDeleted })

    await click(button(el, 'Delete this posting'))
    await click(button(el, 'Delete it'))

    expect(await db.postings.count()).toBe(0)
    // The panel has to re-read the active tab as well as the list, or the badge
    // and the revisit banner go on asserting a record that is gone.
    expect(onDeleted).toHaveBeenCalled()
  })

  it('offers nothing to delete on a new draft', async () => {
    const el = await render({ editing: null })

    // There is no record behind an unsaved draft. It is discarded, not deleted.
    expect(el.textContent).not.toContain('Delete this posting')
  })
})

describe('a new draft', () => {
  it('still saves as a new record', async () => {
    const el = await render({ editing: null })

    await type(control(el, 'Company') as HTMLInputElement, 'Acme')
    await type(control(el, 'Job title') as HTMLInputElement, 'Staff Engineer')
    await submit(el)

    expect(await db.postings.count()).toBe(1)
    expect(el.textContent).not.toContain('Editing a saved posting')
  })

  /**
   * The duplicate prompt is the new-draft path's, and it has to stay there. It
   * is skipped when editing — an edit writes no second record by construction —
   * so a regression that skipped it everywhere would be invisible from the edit
   * tests alone.
   */
  it('still warns before writing a second copy of something stored', async () => {
    await upsertPosting(db, stored())
    const el = await render({ editing: null })

    await type(control(el, 'Company') as HTMLInputElement, 'Initech')
    await type(control(el, 'Job title') as HTMLInputElement, 'Staff Engineer')
    await submit(el)

    expect(el.textContent).toContain('already saved')
    expect(await db.postings.count()).toBe(1)
  })
})
