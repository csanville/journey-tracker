import 'fake-indexeddb/auto'
import { beforeEach, vi } from 'vitest'

/**
 * A minimal in-memory `chrome.storage`.
 *
 * Hand-written rather than pulled from a mocking library because the surface
 * actually used is tiny, and `onChanged` needs to fire for real — the migration
 * guard in `waitForMigration` is built on it, so a stub that skipped it would
 * quietly make those tests vacuous.
 *
 * Two areas, because they hold different things for different reasons. `local`
 * is settings and the migration flag: durable, and the one store a migration is
 * not itself rewriting (decision 9). `session` is the detection cache —
 * page-derived, never written to disk, gone when the browser closes (see
 * `lib/detection.ts`).
 */
type Listener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void

type Emit = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void

function createArea(name: string, emit: Emit) {
  let store: Record<string, unknown> = {}

  return {
    clear() {
      store = {}
    },
    api: {
      async get(keys?: string | string[] | null) {
        if (keys == null) return { ...store }
        const wanted = Array.isArray(keys) ? keys : [keys]
        return Object.fromEntries(
          wanted.filter((k) => k in store).map((k) => [k, store[k]]),
        )
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, chrome.storage.StorageChange> = {}
        for (const [key, newValue] of Object.entries(items)) {
          changes[key] = { oldValue: store[key], newValue }
          store[key] = newValue
        }
        emit(changes, name)
      },
      async remove(keys: string | string[]) {
        const doomed = Array.isArray(keys) ? keys : [keys]
        const changes: Record<string, chrome.storage.StorageChange> = {}
        for (const key of doomed) {
          if (!(key in store)) continue
          changes[key] = { oldValue: store[key], newValue: undefined }
          delete store[key]
        }
        emit(changes, name)
      },
      async clear() {
        store = {}
      },
    },
  }
}

function createStorageStub() {
  const listeners = new Set<Listener>()

  const emit: Emit = (changes, area) => {
    for (const listener of [...listeners]) listener(changes, area)
  }

  const local = createArea('local', emit)
  const session = createArea('session', emit)

  return {
    reset() {
      local.clear()
      session.clear()
      listeners.clear()
    },
    local: local.api,
    session: session.api,
    onChanged: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    },
  }
}

const storage = createStorageStub()

/**
 * The toolbar and the broadcast channel, as spies.
 *
 * Real enough to assert against and inert enough to ignore. Both are reachable
 * from the detection path now that a report repaints the badge and tells the
 * panel, and neither exists in a Node process — without them every handler test
 * that reports a detection would fail on a missing global rather than on
 * anything it was written to check.
 *
 * `sendMessage` resolves rather than rejecting. Chrome rejects it when no
 * receiver exists, and `broadcast` swallows exactly that; a stub that rejected
 * would test the swallow and nothing else. `events.test.ts` covers the
 * rejection case explicitly instead.
 */
const action = {
  setBadgeText: vi.fn(async () => undefined),
  setBadgeBackgroundColor: vi.fn(async () => undefined),
}

const runtime = {
  sendMessage: vi.fn(async () => undefined),
}

vi.stubGlobal('chrome', {
  storage: {
    local: storage.local,
    session: storage.session,
    onChanged: storage.onChanged,
  },
  runtime,
  action,
})

beforeEach(() => {
  storage.reset()
  action.setBadgeText.mockClear()
  action.setBadgeBackgroundColor.mockClear()
  runtime.sendMessage.mockClear()
})
