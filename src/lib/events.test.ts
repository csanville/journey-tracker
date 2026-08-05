import { describe, expect, it, vi } from 'vitest'
import { broadcast, isEvent } from './events'

describe('isEvent', () => {
  it('accepts a detection change', () => {
    expect(isEvent({ type: 'detection/changed', tabId: 4 })).toBe(true)
  })

  it('accepts a submission, which carries the record it is about', () => {
    expect(isEvent({ type: 'application/submitted', tabId: 4, postingId: 'p1' })).toBe(true)
  })

  /**
   * The second member of the union is where "refresh everything" stops being
   * the right answer for the panel (decision 16), so the panel branches on
   * `type` — and a submission without a `postingId` would take that branch and
   * ask about a record that was never named.
   */
  it('rejects a submission that does not say which record', () => {
    expect(isEvent({ type: 'application/submitted', tabId: 4 })).toBe(false)
    expect(isEvent({ type: 'application/submitted', tabId: 4, postingId: 7 })).toBe(false)
  })

  it('rejects an event type it does not know', () => {
    expect(isEvent({ type: 'application/withdrawn', tabId: 4 })).toBe(false)
  })

  it('rejects a request', () => {
    // The whole reason events are keyed on `type` and requests on `kind`:
    // neither guard can ever accept the other's messages, so a broadcast
    // cannot reach the dispatcher and be thrown out as an unknown kind.
    expect(isEvent({ kind: 'posting/list' })).toBe(false)
  })

  it('rejects a change that does not say which tab', () => {
    expect(isEvent({ type: 'detection/changed' })).toBe(false)
    expect(isEvent({ type: 'detection/changed', tabId: '4' })).toBe(false)
  })

  it('rejects the things a message channel actually delivers', () => {
    expect(isEvent(null)).toBe(false)
    expect(isEvent(undefined)).toBe(false)
    expect(isEvent('detection/changed')).toBe(false)
  })
})

describe('broadcast', () => {
  it('sends the event', async () => {
    await broadcast({ type: 'detection/changed', tabId: 9 })

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'detection/changed',
      tabId: 9,
    })
  })

  it('survives there being no panel open', async () => {
    // The ordinary case, not the exceptional one. Chrome rejects with "Could
    // not establish connection" whenever nothing is listening, which is most
    // of the time — letting that through would abort the detection path that
    // called it and fill the console with a failure meaning "as intended".
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    )

    await expect(
      broadcast({ type: 'detection/changed', tabId: 9 }),
    ).resolves.toBeUndefined()
  })
})
