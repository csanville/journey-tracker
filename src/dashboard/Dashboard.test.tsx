// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Dexie from 'dexie'
import { Dashboard } from './Dashboard'
import { JourneyTrackerDb, DB_NAME } from '../lib/db'
import { upsertPosting } from '../lib/repository'
import { aPosting } from '../test/factories'

/**
 * A smoke test over the page's four states, not a test of the arithmetic —
 * that lives in `lib/dashboard/aggregate.test.ts`, against pure functions.
 *
 * What this catches is the class of thing typechecking does not: a branch that
 * throws when it renders. The page has four of them and three are the unhappy
 * ones, which are exactly the ones nobody sees while building it.
 *
 * The database is torn down between cases. `fake-indexeddb` is per-process, not
 * per-test, and these all open `DB_NAME` rather than a generated name because
 * the component under test is the thing choosing it.
 */

// Tells React that `act` is available, which suppresses the warning it prints
// on every update outside one.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

let root: Root | null = null
let host: HTMLDivElement | null = null

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)

  await act(async () => {
    root = createRoot(host!)
    root.render(<Dashboard />)
  })

  return host
}

/**
 * Polls rather than sleeping a fixed amount.
 *
 * The failure path is the reason: `send` retries a cold worker four times with a
 * linear backoff, so "could not read" takes about 300ms to appear and a 50ms
 * sleep asserts against a page that is still, correctly, saying "loading".
 */
async function waitForText(el: HTMLElement, text: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (el.textContent?.includes(text)) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  throw new Error(`timed out waiting for ${JSON.stringify(text)}; saw: ${el.textContent}`)
}

beforeEach(async () => {
  await Dexie.delete(DB_NAME)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  await Dexie.delete(DB_NAME)
})

/** The worker's connection — the only context that declares a schema. */
async function seed(postings: number, applied: number): Promise<void> {
  const db = new JourneyTrackerDb(DB_NAME)
  await db.open()

  for (let i = 0; i < postings; i++) {
    await upsertPosting(
      db,
      aPosting({
        id: `p-${i}`,
        company: `Company ${i}`,
        url: `https://boards.greenhouse.io/c${i}/jobs/${i}`,
        canonicalUrl: `https://boards.greenhouse.io/c${i}/jobs/${i}`,
        state: i < applied ? 'applied' : 'viewed',
        appliedAt: i < applied ? Date.now() : null,
      }),
    )
  }

  db.close()
}

describe('Dashboard', () => {
  it('says it is reading before it has read anything', async () => {
    // Never "nothing saved yet" — that is a false statement about someone's
    // records, made in the one place that exists to reassure them.
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      (() => new Promise(() => {})) as never,
    )

    const el = await render()

    expect(el.textContent).toContain('Reading your history')
    expect(el.textContent).not.toContain('Nothing saved yet')
  })

  it('reports an unreachable worker as a failure, not as an empty database', async () => {
    // No database, and nothing answering the request to create one.
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined as never)

    const el = await render()
    await waitForText(el, 'Could not read your history')

    expect(el.textContent).not.toContain('Nothing saved yet')
  })

  it('invites a first record over an empty database', async () => {
    await seed(0, 0)

    const el = await render()
    await waitForText(el, 'Nothing saved yet')
  })

  it('renders the three views over real records', async () => {
    await seed(5, 2)

    const el = await render()
    await waitForText(el, 'Where things stand')

    expect(el.textContent).toContain('Over time')
    expect(el.textContent).toContain('Per board')
    expect(el.textContent).toContain('5 postings')
    // 2 of 5 applied.
    expect(el.textContent).toContain('40%')
    expect(el.querySelectorAll('.timeline__bucket')).toHaveLength(12)
    expect(el.querySelector('.boards tbody th')?.textContent).toContain('Greenhouse')
  })

  it('says "1 posting" rather than "1 postings"', async () => {
    await seed(1, 0)

    const el = await render()
    await waitForText(el, '1 posting')

    expect(el.textContent).not.toContain('1 postings')
  })

  it('discloses an application made before the window even when nothing else is', async () => {
    // Back-filling an old application: saved today, so `createdAt` is inside the
    // window, with a hand-typed `appliedAt` from six months ago. `place` handles
    // the two timestamps independently, so this lands in `beforeWindow.applied`
    // while `beforeWindow.tracked` stays at zero — and gating the note on
    // `tracked` alone drops it. The funnel then says one applied over a chart
    // showing none, with nothing to explain the gap.
    const db = new JourneyTrackerDb(DB_NAME)
    await db.open()
    await upsertPosting(
      db,
      aPosting({
        id: 'backfilled',
        state: 'applied',
        appliedAt: Date.now() - 180 * 86_400_000,
      }),
    )
    db.close()

    const el = await render()
    await waitForText(el, 'Where things stand')

    expect(el.querySelector('.note')?.textContent).toContain('before this window')
  })

  it('re-renders when a record is saved while it is open', async () => {
    // The reactivity the whole read path exists for. Without it the dashboard
    // would need the polling decision 4 ruled out.
    await seed(1, 0)

    const el = await render()
    await waitForText(el, '1 posting')

    const worker = new JourneyTrackerDb(DB_NAME)
    await worker.open()
    await upsertPosting(worker, aPosting({ id: 'later', company: 'Later' }))

    await waitForText(el, '2 postings')
    worker.close()
  })
})
