import type { DuplicateMatch, Posting, PostingInput, Snapshot } from './types'

/**
 * The panel-to-worker protocol.
 *
 * Typed as a map rather than a union so a caller gets the right response type
 * from the request kind alone, and adding a message without handling it is a
 * compile error rather than a runtime surprise.
 */
/** For messages that carry nothing but their kind. */
type NoPayload = Record<never, never>

export interface RequestMap {
  'posting/upsert': { payload: { posting: PostingInput }; result: Posting }
  'posting/get': { payload: { id: string }; result: Posting | null }
  'posting/list': { payload: NoPayload; result: Posting[] }
  'posting/count': { payload: NoPayload; result: number }
  'posting/delete': { payload: { id: string }; result: { deleted: string } }
  /**
   * Reports an existing record that may be the same posting, with which key
   * matched so the caller can weigh it. Reports only — never merges.
   */
  'posting/find-duplicate': {
    payload: { posting: PostingInput }
    result: DuplicateMatch | null
  }
  'snapshot/put': { payload: { snapshot: Snapshot }; result: { postingId: string } }
  'snapshot/get': { payload: { postingId: string }; result: Snapshot | null }
  status: { payload: NoPayload; result: StatusReport }
  /**
   * Re-reads storage protection and records the answer. The panel sends this
   * after calling `persist()`, which only a Window context can do — the worker
   * would otherwise keep reporting the state it read before the request.
   */
  'storage/reassess': { payload: NoPayload; result: StatusReport }
}

export type RequestKind = keyof RequestMap

/**
 * Distributive on purpose. Written as a plain intersection this collapses into
 * `{ kind: every-kind } & { every-payload }`, which no real message satisfies
 * and which defeats narrowing in the dispatch switch.
 */
export type Request<K extends RequestKind = RequestKind> = K extends RequestKind
  ? { kind: K } & RequestMap[K]['payload']
  : never

export type Result<K extends RequestKind> = RequestMap[K]['result']

export type Response<K extends RequestKind> =
  { ok: true; data: Result<K> } | { ok: false; error: string }

/** What the worker can tell the panel about its own health. */
export interface StatusReport {
  schemaVersion: number
  dataVersion: number
  migrationInProgress: boolean
  storagePersisted: boolean | null
  storageUnlimited: boolean | null
  /**
   * The one the UI should act on. Either defence alone is enough, so warning on
   * `storagePersisted` by itself would cry wolf on every fresh install.
   */
  evictionSafe: boolean
  postingCount: number
}

export function isRequest(value: unknown): value is Request {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}
