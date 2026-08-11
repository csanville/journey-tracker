// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JourneyTrackerDb } from '../lib/db'
import type { DetectionReport } from '../lib/detection'
import { handleRequest } from '../lib/handler'
import { recordFailedParse } from '../lib/detection'
import { recordPending } from '../lib/pending'
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
   * Raises a question the way the worker does: write it down, then say so.
   *
   * Both halves, in that order, because the order is the phase. `recordPending`
   * is what survives a closed panel; the signal only gets an open one to look
   * sooner. `tabId` is not decoration — `isEvent` rejects an event without a
   * numeric one, so a message shaped by hand and missing it would be ignored
   * silently rather than failing loudly.
   */
  async function announce(postingId: string, confirmedAt = Date.now()) {
    await recordPending(postingId, confirmedAt)
    await act(async () => {
      emitMessage({ type: 'submission/pending', tabId: 7 })
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
   * The ordering phase 9's guard did not cover, and the likelier of the two: the
   * prompt names a company and a title and nothing else, so opening the record
   * to see which one it means is the obvious way to answer it.
   *
   * Left alone, the form seeds a draft holding `state: 'viewed'`, confirming the
   * prompt writes `applied`, and the next Save writes `viewed` and a null
   * `appliedAt` back over it — silently discarding the user's own answer and the
   * date the response funnel is anchored on.
   */
  it('stands the prompt down when the user opens that record to look at it', async () => {
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const el = await render()

    await announce(posting.id)
    expect(el.textContent).toContain('Looks like you applied')

    await click(el.querySelector('.recent__open')!)

    expect(el.textContent).toContain('Editing a saved posting')
    expect(el.textContent).not.toContain('Looks like you applied')
  })

  /**
   * **This reverses phase 9's behaviour, deliberately.**
   *
   * That phase retired the prompt outright when the user opened the record,
   * and asserted here that it did not come back. The reason given was sound at
   * the time: re-showing it meant rendering a `Posting` captured before the user
   * touched it, which the form may since have saved as `applied`.
   *
   * That objection is gone. `refreshPending` re-reads the record from the worker
   * every time and retires anything that now says `applied`, so what comes back
   * is current or does not come back at all. And the question was never
   * answered — the user looked at the record and closed it again — so retiring
   * it was discarding a real signal on the strength of a glance. Skipping while
   * the form owns it, and asking again when it lets go, is what the store makes
   * possible.
   */
  it('asks again once the user stops editing without answering', async () => {
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const el = await render()

    await announce(posting.id)
    await click(el.querySelector('.recent__open')!)
    expect(el.textContent).not.toContain('Looks like you applied')

    await click(button(el, 'Stop editing'))

    expect(el.textContent).toContain('Looks like you applied')
  })

  it('does not ask again about a record the form saved as applied', async () => {
    // The other side of the reversal: coming back is only safe because the
    // record is re-read, so a form that answered the question by hand settles it.
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    const el = await render()

    await announce(posting.id)
    await click(el.querySelector('.recent__open')!)
    await upsertPosting(db, { ...posting, state: 'applied', appliedAt: Date.now() })
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
    // one — standing down is about the collision, not about editing in general.
    const rows = [...el.querySelectorAll('.recent__open')]
    const row = rows.find((r) => r.textContent?.includes(open.company))!
    await click(row)

    expect(el.textContent).toContain('Looks like you applied')
  })
})

/**
 * The phase itself: a question asked with nobody listening.
 *
 * Every test above emits the signal to an already-mounted panel, which is the
 * case phase 8 built and the case that was never the problem. These start with
 * the question already in the store and no event at all — the panel was shut
 * when the confirmation page was seen, which is what happens almost every time
 * somebody actually applies to a job.
 */
describe('a submission confirmed while the panel was closed', () => {
  it('asks on open, with no event to prompt it', async () => {
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    await recordPending(posting.id, Date.now())

    const el = await render()

    expect(el.textContent).toContain('Looks like you applied')
  })

  /**
   * The reason the store holds a timestamp at all.
   *
   * `appliedAt` is what the response funnel measures every wait from, and a
   * prompt that can outlive a browser session is a prompt that can be answered
   * days after the fact. Recording the click would move every application
   * forward to whenever the user next opened the panel.
   */
  it('records the date of the confirmation, not the date of the answer', async () => {
    // Three days ago: long enough that recording the click would be visibly
    // wrong, comfortably inside the TTL so the question is still asked. A fixed
    // calendar date would silently stop testing anything once it aged past
    // `PENDING_TTL_MS` — which is exactly what a first draft of this did.
    const confirmedAt = Date.now() - 3 * 24 * 60 * 60 * 1000
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    await recordPending(posting.id, confirmedAt)

    const el = await render()
    await click(button(el, 'Yes, applied'))

    const saved = await db.postings.get(posting.id)
    expect(saved?.state).toBe('applied')
    expect(saved?.appliedAt).toBe(confirmedAt)
  })

  it('asks about three of them one at a time, oldest first', async () => {
    const first = await upsertPosting(db, aPosting({ company: 'Acme', state: 'viewed' }))
    const second = await upsertPosting(
      db,
      aPosting({ company: 'Initech', state: 'viewed' }),
    )
    const third = await upsertPosting(db, aPosting({ company: 'Globex', state: 'viewed' }))
    // Relative to now, so they stay inside the TTL. Recorded out of order to
    // prove the queue sorts by confirmation date rather than by insertion.
    const minute = 60 * 1000
    await recordPending(third.id, Date.now() - minute)
    await recordPending(first.id, Date.now() - 3 * minute)
    await recordPending(second.id, Date.now() - 2 * minute)

    const el = await render()
    expect(el.textContent).toContain('Acme')

    await click(button(el, 'Not this one'))
    expect(el.textContent).toContain('Initech')

    await click(button(el, 'Not this one'))
    expect(el.textContent).toContain('Globex')

    await click(button(el, 'Not this one'))
    expect(el.textContent).not.toContain('Looks like you applied')
  })

  /**
   * Dismissal has to outlive the panel or it is not an answer.
   *
   * Phase 9 kept dismissals in a ref scoped to the panel's lifetime, which was
   * the only place available then — so "no" lasted until the panel was closed
   * and the question returned on the next confirmation-page load. Unmounting and
   * remounting is that, in a test.
   */
  it('does not re-ask a question that was dismissed before the panel closed', async () => {
    const posting = await upsertPosting(db, aPosting({ state: 'viewed' }))
    await recordPending(posting.id, Date.now())

    const first = await render()
    await click(button(first, 'Not this one'))
    await act(async () => root!.unmount())
    root = null

    const second = await render()

    expect(second.textContent).not.toContain('Looks like you applied')
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

describe('the report you can send', () => {
  /**
   * jsdom has no clipboard. Defined per test rather than in `setup.ts` because
   * this is the only surface that writes to one, and the refusal case below
   * needs to swap the implementation.
   */
  function stubClipboard(writeText = vi.fn(async () => undefined)) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    return writeText
  }

  /**
   * Seeds a detection for the tab the panel sits beside.
   *
   * Load-bearing for the churn tests below, and the reason the first version of
   * them was vacuous: with no detection, every refresh resolves `null`,
   * `setDetection(null)` is a no-op React bails out of, and no identity ever
   * changes. The churn needs a value that comes back as a new object each time,
   * which is exactly what a real detection is.
   */
  async function seedDetection(): Promise<void> {
    const report: DetectionReport = {
      detectionId: 'det-churn',
      url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
      source: 'lever',
      adapterVersion: 'lever@1',
      confidence: 0.7,
      fields: {
        company: 'Acme',
        jobTitle: 'Staff Engineer',
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
      snapshot: { trimmedSource: '<html>the posting</html>', truncated: false },
    }
    await handleRequest(db, { kind: 'detection/report', report }, { tabId: 7 })
  }

  function reportText(el: HTMLElement): string {
    const pre = el.querySelector('.report__text')
    if (!pre) throw new Error('no report rendered')

    return pre.textContent ?? ''
  }

  /**
   * The whole of decision 1's amendment. The user is being asked to judge what
   * they are about to paste into a public issue, and they can only do that if
   * the text on screen *is* the text on the clipboard — not a summary of it and
   * not a sample. One string, used twice.
   */
  it('copies exactly the text it showed', async () => {
    const writeText = stubClipboard()
    const el = await render()

    const shown = reportText(el)
    expect(shown).toContain('JourneyTracker diagnostics')

    await click(button(el, 'Copy report'))

    expect(writeText).toHaveBeenCalledWith(shown)
    expect(el.textContent).toContain('Copied')
  })

  /**
   * The state a bug report is most likely to be about, and the one the first
   * version rendered no report for at all — the section was gated on `status`.
   */
  it('still renders a report when the service worker does not answer', async () => {
    stubClipboard()
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error('Could not establish connection'),
    )

    const el = await render()

    expect(reportText(el)).toContain('worker     no answer')
    expect(button(el, 'Copy report')).toBeTruthy()
  })

  it('says nothing has read the page when the tab never reported', async () => {
    stubClipboard()
    const el = await render()

    expect(reportText(el)).toContain('parse      none — not-read')
    expect(reportText(el)).toContain('page       not reported')
  })

  it('describes a blank read when the tab reported one', async () => {
    stubClipboard()
    await recordFailedParse(7, {
      url: 'https://careers.acme.com/openings/42',
      source: 'generic',
      adapterVersion: 'generic@1',
      confidence: 0,
      provenance: {
        company: null,
        jobTitle: null,
        location: null,
        workMode: null,
        atsReqId: null,
        salary: null,
      },
    })

    const el = await render()

    expect(reportText(el)).toContain('generic@1')
    expect(reportText(el)).toContain('careers.acme.com')
    expect(reportText(el)).toContain('offered    no — needs a company or a job title')
  })

  it('carries no field value out of a page that parsed', async () => {
    stubClipboard()
    await seedDetection()

    const el = await render()
    const shown = reportText(el)

    // The panel holds the whole summary, fields included, and this is the one
    // place a real render could put them on a clipboard.
    expect(shown).toContain('lever@1')
    expect(shown).not.toContain('Acme')
    expect(shown).not.toContain('Staff Engineer')
    expect(shown).not.toContain('00000000-0000-4000-8000-000000000000')
  })

  /**
   * The churn review found. `refreshDetection` runs on every window focus and
   * always sets a freshly deserialized `detection`, so a memo keyed on object
   * identity recomputed when nothing had changed — moving the timestamp and
   * resetting the copied state.
   *
   * It bites hardest in the one flow that asks the user to interact with the
   * text: the clipboard refuses, they are told to select it by hand, and
   * clicking into the panel to do so fires the focus that wipes the selection
   * and the message together.
   */
  it('leaves the report alone when a focus refresh changes nothing', async () => {
    stubClipboard()
    await seedDetection()
    const el = await render()

    const before = reportText(el)

    await act(async () => {
      globalThis.dispatchEvent(new Event('focus'))
    })
    await settle()

    expect(reportText(el)).toBe(before)
  })

  it('keeps a copy acknowledgement across a focus refresh', async () => {
    stubClipboard()
    await seedDetection()
    const el = await render()

    await click(button(el, 'Copy report'))
    expect(el.textContent).toContain('Copied')

    await act(async () => {
      globalThis.dispatchEvent(new Event('focus'))
    })
    await settle()

    expect(el.textContent).toContain('Copied')
  })

  /**
   * Chrome refuses the clipboard when the document is not focused, which a side
   * panel loses easily. A button that looked like it worked would be the worse
   * failure: the text is on screen and can be selected by hand, so saying so is
   * an instruction rather than an apology.
   */
  it('says so when the clipboard refuses, rather than claiming it copied', async () => {
    stubClipboard(vi.fn(async () => Promise.reject(new Error('Document is not focused'))))
    const el = await render()

    await click(button(el, 'Copy report'))

    expect(el.textContent).toContain('Could not reach the clipboard')
    expect(el.textContent).not.toContain('Copied')
  })
})
