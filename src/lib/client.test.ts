import { afterEach, describe, expect, it, vi } from 'vitest'
import { send } from './client'

/**
 * The retry classifier decides whether a failure is a cold service worker or a
 * real error. Both mistakes are cheap to make and neither is visible: retrying
 * something permanent just adds latency before the same failure, and giving up
 * on something transient turns an ordinary worker restart into a lost write.
 */
function stubSendMessage(responses: Array<() => unknown>) {
  const calls: unknown[] = []
  let index = 0

  const sendMessage = vi.fn(async (message: unknown) => {
    calls.push(message)
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return next!()
  })

  vi.stubGlobal('chrome', { runtime: { sendMessage } })

  return { sendMessage, calls }
}

const ok = (data: unknown) => () => ({ ok: true, data })
const throws = (message: string) => () => {
  throw new Error(message)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('send', () => {
  it('returns the payload on a first-attempt success', async () => {
    stubSendMessage([ok(7)])

    expect(await send('posting/count', {})).toBe(7)
  })

  it('retries a worker that has not woken up yet', async () => {
    const { sendMessage } = stubSendMessage([
      throws('Could not establish connection. Receiving end does not exist.'),
      ok(3),
    ])

    expect(await send('posting/count', {})).toBe(3)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('retries an empty response, which is what a torn-down worker looks like', async () => {
    // `sendMessage` resolving `undefined` is the most likely cold-start symptom:
    // a listener closed the channel without answering. Classified as permanent,
    // it broke out on the first attempt and the retries never ran at all.
    const { sendMessage } = stubSendMessage([() => undefined, ok(1)])

    expect(await send('posting/count', {})).toBe(1)
    expect(sendMessage).toHaveBeenCalledTimes(2)
  })

  it('does not retry an invalidated extension context', async () => {
    // The page belongs to a previous generation of the extension. Nothing it
    // sends will ever arrive, so retrying only delays the inevitable.
    const { sendMessage } = stubSendMessage([throws('Extension context invalidated.')])

    await expect(send('posting/count', {})).rejects.toThrow(/invalidated/)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('does not retry an error the worker deliberately returned', async () => {
    const { sendMessage } = stubSendMessage([
      () => ({ ok: false, error: 'no such posting' }),
    ])

    await expect(send('posting/get', { id: 'nope' })).rejects.toThrow('no such posting')
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('gives up rather than retrying forever', async () => {
    const { sendMessage } = stubSendMessage([
      throws('The message port closed before a response'),
    ])

    await expect(send('posting/count', {})).rejects.toThrow(/message port closed/)
    expect(sendMessage).toHaveBeenCalledTimes(4)
  })

  it('sends the kind alongside the payload', async () => {
    const { calls } = stubSendMessage([ok(null)])

    await send('posting/get', { id: 'abc' })

    expect(calls[0]).toEqual({ kind: 'posting/get', id: 'abc' })
  })
})
