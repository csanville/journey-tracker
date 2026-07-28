import type { Request, RequestKind, RequestMap, Response, Result } from './messages'

/**
 * The panel's side of the protocol.
 *
 * Retries exist because an MV3 service worker is torn down when idle and takes
 * a moment to come back; a message sent into that window fails with a
 * connection error rather than a real one. Retrying is only safe because every
 * mutation is idempotent — see `upsertPosting`.
 */

const MAX_ATTEMPTS = 4
const BASE_DELAY_MS = 50

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('message port closed') ||
    message.includes('Extension context invalidated')
  )
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function send<K extends RequestKind>(
  kind: K,
  payload: RequestMap[K]['payload'],
): Promise<Result<K>> {
  let lastError: unknown

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = (await chrome.runtime.sendMessage({
        kind,
        ...payload,
      } as Request<K>)) as Response<K> | undefined

      if (!response) throw new Error('no response from the service worker')
      if (!response.ok) throw new Error(response.error)
      return response.data
    } catch (error) {
      lastError = error
      if (!isTransient(error) || attempt === MAX_ATTEMPTS - 1) break
      // Linear backoff: the worker restarts in tens of milliseconds, so this is
      // waiting for a cold start, not backing off a loaded server.
      await wait(BASE_DELAY_MS * (attempt + 1))
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
