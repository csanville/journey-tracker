// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JourneyTrackerDb } from '../lib/db'
import type { DetectionReport } from '../lib/detection'
import { handleRequest } from '../lib/handler'
import { upsertPosting } from '../lib/repository'
import { aPosting } from '../test/factories'
import { emitMessage } from '../test/setup'
import { App } from './App'

/**
 * The panel as a whole, which is the only level at which the submission prompt
 * and the form can be seen owning the same record.
 *
 * `PostingForm.test.tsx` mounts the form on its own and therefore cannot reach
 * this: the prompt lives in `App`, the draft lives in the form, and the defect
 * is that both hold the same posting at once. A review found it, and the reason
 * no test had is that nothing had ever rendered the two together.
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let db: JourneyTrackerDb
let root: Root | null = null
let host: HTMLDivElement | null = null
let counter = 0

beforeEach(async () => {
  db = new JourneyTrackerDb(`jt-app-${Date.now()}-${counter++}`)
  await db.open()
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

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)

  await act(async () => {
    root = createRoot(host!)
    root.render(<App />)
  })

  await settle()
  return host
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
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

describe('a submission prompt and the form claiming the same record', () => {
  /**
   * Raises the prompt the way the worker does, for a record on this tab.
   *
   * `tabId` is not decoration: `isEvent` rejects an event without a numeric one,
   * so a message shaped by hand and missing it is silently ignored rather than
   * failing loudly. The positive control above is what makes that visible.
   */
  async function announce(postingId: string) {
    await act(async () => {
      emitMessage({ type: 'application/submitted', tabId: 7, postingId })
    })
    await settle()
  }

  it('raises the prompt for a record nobody is editing', async () => {
    // The positive control. Without it every assertion below could pass by the
    // prompt never having appeared at all.
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const el = await render()

    await announce(posting.id)

    expect(el.textContent).toContain('Looks like you applied')
  })

  /**
   * The ordering the guard in `announceSubmitted` did not cover, and the likelier
   * of the two: the prompt names a company and a title and nothing else, so
   * opening the record to see which one it means is the obvious way to answer it.
   *
   * Left alone, the form seeds a draft holding `state: 'viewed'`, confirming the
   * prompt writes `applied`, and the next Save writes `viewed` and a null
   * `appliedAt` back over it — silently discarding the user's own answer and the
   * date the response funnel is anchored on.
   */
  it('retires the prompt when the user opens that record to look at it', async () => {
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const el = await render()

    await announce(posting.id)
    expect(el.textContent).toContain('Looks like you applied')

    await click(el.querySelector('.recent__open')!)

    expect(el.textContent).toContain('Editing a saved posting')
    expect(el.textContent).not.toContain('Looks like you applied')
  })

  /**
   * Retired, not hidden — the distinction the fix turns on.
   *
   * Re-showing the prompt on the way out would mean rendering a `Posting`
   * captured before the user touched it, which may since have been saved as
   * `applied` by the very form that was covering it. The question is only asked
   * again by a fresh event, and `announceSubmitted` re-reads the record and
   * declines to ask about one that already says `applied`.
   */
  it('does not bring the prompt back when editing stops', async () => {
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const el = await render()

    await announce(posting.id)
    await click(el.querySelector('.recent__open')!)
    await click(button(el, 'Stop editing'))

    expect(el.textContent).not.toContain('Looks like you applied')
  })

  it('leaves a prompt about some other record alone', async () => {
    const open = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const other = await upsertPosting(
      db,
      aPosting({ company: 'Globex', jobTitle: 'Analyst', state: 'viewed' }),
    )
    const el = await render()

    await announce(other.id)
    // Opening an unrelated record must not swallow a question about a different
    // one — retiring is about the collision, not about editing in general.
    const rows = [...el.querySelectorAll('.recent__open')]
    const row = rows.find((r) => r.textContent?.includes(open.company))!
    await click(row)

    expect(el.textContent).toContain('Looks like you applied')
  })
})

/**
 * The revisit banner outliving the record it names.
 *
 * Lives here rather than beside the form because the wiring is what makes it
 * reachable: the banner is hidden while a record is open for editing, and only
 * `App` clearing `editing` on the way out lets it back onto the screen. A test
 * that stubbed `onStopEditing` would re-open the deleted record instead and
 * pass without proving anything — which is exactly what a first attempt did.
 */
describe('the revisit banner and a deleted record', () => {
  /** The page the seeded record came from, so `findDuplicate` matches it. */
  function aMatchingReport(): DetectionReport {
    return {
      detectionId: 'det-same',
      url: 'https://boards.greenhouse.io/initech/jobs/4021',
      source: 'greenhouse',
      adapterVersion: 'greenhouse@3',
      confidence: 0.9,
      fields: {
        company: 'Initech',
        jobTitle: 'Staff Engineer',
        location: 'Austin, TX',
        workMode: 'hybrid',
        atsReqId: 'REQ-4021',
        salary: null,
      },
      provenance: {
        company: 'dom',
        jobTitle: 'dom',
        location: 'dom',
        workMode: 'dom',
        // Null rather than a tier: the requisition id comes off the URL, which
        // is not one of the four readers `Tier` names.
        atsReqId: null,
        salary: null,
      },
      snapshot: { trimmedSource: '<html>the posting</html>', truncated: false },
    }
  }

  /**
   * Fills the detection cache the way a content script would.
   *
   * Called through `handleRequest` directly rather than the mocked `sendMessage`,
   * because a report only counts when it arrives with a tab id and the mock has
   * no sender to supply one. Tab 7 is what the stubbed `tabs.query` returns.
   */
  async function seedDetection() {
    await handleRequest(
      db,
      { kind: 'detection/report', report: aMatchingReport() },
      {
        tabId: 7,
      },
    )
  }

  it('says you have been here before, for a record that exists', async () => {
    // The positive control, without which every assertion below could pass by
    // the banner never having appeared at all.
    await seedDetection()
    await upsertPosting(db, aPosting())
    const el = await render()

    expect(el.textContent).toContain('You looked at this on')
  })

  it('stops saying it once that record has been deleted', async () => {
    await seedDetection()
    await upsertPosting(db, aPosting())
    const el = await render()
    expect(el.textContent).toContain('You looked at this on')

    await click(el.querySelector('.recent__open')!)
    // The page auto-filled the form on mount, so opening a record asks before
    // discarding it — decision 13 reaching the edit path, and the reason this
    // flow has one more click in it than the prompt tests above.
    expect(el.textContent).toContain('Open a different posting?')
    await click(button(el, 'Open it'))

    await click(button(el, 'Delete this posting'))
    await click(button(el, 'Delete it'))

    expect(await db.postings.count()).toBe(0)
    expect(el.textContent).not.toContain('You looked at this on')
  })
})
