import 'fake-indexeddb/auto'
import { beforeEach, vi } from 'vitest'

/**
 * A minimal in-memory `chrome.storage.local`.
 *
 * Hand-written rather than pulled from a mocking library because the surface
 * actually used is tiny, and `onChanged` needs to fire for real — the migration
 * guard in `waitForMigration` is built on it, so a stub that skipped it would
 * quietly make those tests vacuous.
 */
type Listener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void

function createStorageStub() {
  let store: Record<string, unknown> = {}
  const listeners = new Set<Listener>()

  const emit = (changes: Record<string, chrome.storage.StorageChange>) => {
    for (const listener of [...listeners]) listener(changes, 'local')
  }

  return {
    reset() {
      store = {}
      listeners.clear()
    },
    local: {
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
        emit(changes)
      },
      async remove(keys: string | string[]) {
        const doomed = Array.isArray(keys) ? keys : [keys]
        const changes: Record<string, chrome.storage.StorageChange> = {}
        for (const key of doomed) {
          if (!(key in store)) continue
          changes[key] = { oldValue: store[key], newValue: undefined }
          delete store[key]
        }
        emit(changes)
      },
      async clear() {
        store = {}
      },
    },
    onChanged: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    },
  }
}

const storage = createStorageStub()

vi.stubGlobal('chrome', {
  storage: {
    local: storage.local,
    onChanged: storage.onChanged,
  },
  runtime: {},
})

beforeEach(() => {
  storage.reset()
})
