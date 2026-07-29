import type { DetectionReport, DetectionSummary } from './detection'
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
  /**
   * `detectionId` attaches the page this record was filled from, so the worker
   * can write the snapshot from its own cache (decision 6). It is a reference
   * rather than the source itself because the source is up to 256KB of page
   * text that the panel has no use for — see `detection.ts`.
   */
  'posting/upsert': {
    payload: { posting: PostingInput; detectionId?: string }
    result: Posting
  }
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
  /**
   * The one message a content script sends. The tab it belongs to comes from
   * the sender rather than the payload — a page cannot forge which tab it is.
   * Returns `null` when the report did not survive validation.
   */
  'detection/report': {
    payload: { report: DetectionReport }
    result: { detectionId: string } | null
  }
  /** What the panel asks about the tab it is sitting next to. */
  'detection/get': { payload: { tabId: number }; result: DetectionSummary | null }
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

/**
 * What a content script is allowed to ask for.
 *
 * Only this extension's own content scripts can reach `onMessage` — a web page
 * cannot, absent `externally_connectable`, which the manifest does not declare.
 * So this is not a wall against an attacker; it is a wall against a mistake. A
 * content script runs inside a page whose markup is arbitrary, and the set of
 * things it needs from the worker is exactly one message. Leaving
 * `posting/delete` reachable from that context would be an ambient capability
 * nothing uses and nobody would notice growing teeth.
 */
const CONTENT_SCRIPT_KINDS: readonly RequestKind[] = ['detection/report']

export function allowedFromContentScript(kind: RequestKind): boolean {
  return CONTENT_SCRIPT_KINDS.includes(kind)
}
