import { describe, expect, it } from 'vitest'
import {
  MAX_PENDING,
  PENDING_TTL_MS,
  readPending,
  recordPending,
  retirePending,
} from './pending'

/**
 * The store behind the prompt that survives a closed panel.
 *
 * What is under test is mostly *when a question stops being worth asking*:
 * answered, expired, or evicted. The date carried alongside it gets its own
 * attention because it is the field the response funnel is anchored on, and the
 * whole reason this store holds a timestamp rather than just an id.
 */

const DAY = 24 * 60 * 60 * 1000

describe('recordPending', () => {
  it('keeps a question until it is answered', async () => {
    await recordPending('p-1', 1_000)

    expect(await readPending(2_000)).toEqual([{ postingId: 'p-1', confirmedAt: 1_000 }])
  })

  it('records the confirmation date, not the date it is read back', async () => {
    // The point of the whole store. A prompt raised on Friday and answered on
    // Monday has to put Friday on the record.
    const friday = Date.parse('2026-03-13T17:00:00Z')
    const monday = Date.parse('2026-03-16T09:00:00Z')

    await recordPending('p-1', friday)

    expect(await readPending(monday)).toEqual([{ postingId: 'p-1', confirmedAt: friday }])
  })

  it('treats a reloaded confirmation page as one question, at its first date', async () => {
    // Coming back to a confirmation page is not a second application, and must
    // not re-date the first — the later timestamp would quietly move the record
    // forward if it won.
    await recordPending('p-1', 1_000)
    await recordPending('p-1', 5_000)

    expect(await readPending(6_000)).toEqual([{ postingId: 'p-1', confirmedAt: 1_000 }])
  })

  it('asks about the oldest application first', async () => {
    await recordPending('p-late', 3_000)
    await recordPending('p-early', 1_000)
    await recordPending('p-middle', 2_000)

    expect((await readPending(4_000)).map((p) => p.postingId)).toEqual([
      'p-early',
      'p-middle',
      'p-late',
    ])
  })

  it('keeps the newest when it overflows, not the ones about to expire', async () => {
    // Deliberately the opposite of the answering order: the oldest entry is the
    // one closest to expiring and the one the user can least accurately answer.
    for (let i = 0; i < MAX_PENDING + 5; i++) {
      await recordPending(`p-${i}`, 1_000 + i)
    }

    const pending = await readPending(2_000)

    expect(pending).toHaveLength(MAX_PENDING)
    expect(pending.map((p) => p.postingId)).not.toContain('p-0')
    expect(pending.map((p) => p.postingId)).toContain(`p-${MAX_PENDING + 4}`)
  })
})

describe('readPending', () => {
  it('stops asking once a question is too old to answer honestly', async () => {
    await recordPending('p-1', 0)

    expect(await readPending(PENDING_TTL_MS - DAY)).toHaveLength(1)
    expect(await readPending(PENDING_TTL_MS + DAY)).toEqual([])
  })

  it('forgets an expired question rather than filtering it forever', async () => {
    // Nothing else sweeps this store and `local` is not cleared on browser
    // close, so a read that only filtered would leave it growing for the life of
    // the profile.
    await recordPending('p-1', 0)
    await readPending(PENDING_TTL_MS + DAY)

    const stored = await chrome.storage.local.get('pendingSubmissions')
    expect(stored.pendingSubmissions).toEqual({})
  })

  it('reads an untouched store as no questions rather than failing', async () => {
    expect(await readPending(1_000)).toEqual([])
  })

  it('drops entries whose shape it does not recognise', async () => {
    // This store outlives a browser restart, and therefore the build that wrote
    // it — unlike the detection cache, which cannot see a shape from another
    // version.
    await chrome.storage.local.set({
      pendingSubmissions: { 'p-good': 1_000, 'p-bad': 'yesterday', 'p-worse': null },
    })

    expect(await readPending(2_000)).toEqual([{ postingId: 'p-good', confirmedAt: 1_000 }])
  })
})

describe('retirePending', () => {
  it('answers a question for good', async () => {
    await recordPending('p-1', 1_000)

    expect(await retirePending('p-1')).toBe(true)
    expect(await readPending(2_000)).toEqual([])
  })

  it('says so when there was nothing to answer', async () => {
    expect(await retirePending('p-missing')).toBe(false)
  })

  it('leaves the other questions alone', async () => {
    await recordPending('p-1', 1_000)
    await recordPending('p-2', 2_000)

    await retirePending('p-1')

    expect((await readPending(3_000)).map((p) => p.postingId)).toEqual(['p-2'])
  })
})

describe('concurrent access', () => {
  it('does not lose a question to an interleaved write', async () => {
    // The failure `serialize.ts` exists for: two confirmations arriving close
    // enough that the second read-modify-write starts before the first has
    // written, so one of them lands on a stale snapshot and vanishes.
    await Promise.all([
      recordPending('p-1', 1_000),
      recordPending('p-2', 2_000),
      recordPending('p-3', 3_000),
    ])

    expect((await readPending(4_000)).map((p) => p.postingId)).toEqual([
      'p-1',
      'p-2',
      'p-3',
    ])
  })

  it('does not resurrect a question retired in the gap', async () => {
    await recordPending('p-1', 1_000)

    await Promise.all([retirePending('p-1'), recordPending('p-2', 2_000)])

    expect((await readPending(3_000)).map((p) => p.postingId)).toEqual(['p-2'])
  })
})
