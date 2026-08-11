import 'fake-indexeddb/auto'
import { beforeEach, vi } from 'vitest'

/**
 * A minimal in-memory `chrome.storage`.
 *
 * Hand-written rather than pulled from a mocking library because the surface
 * actually used is tiny.
 *
 * It has no `onChanged`. It used to, with a real listener set and change events
 * emitted from `set` and `remove`, because `waitForMigration` was built on them.
 * Phase 11 deleted that function and nothing in `src/` subscribes to
 * `chrome.storage.onChanged` any more, so the emit machinery went with it — a
 * faithful stub of an API nothing calls is the same "in case one might" the rest
 * of this codebase declines. Anything that grows a subscription brings it back,
 * with the test that needs it.
 *
 * Two areas, because they hold different things for different reasons. `local`
 * is settings and the migration flag: durable, and the one store a migration is
 * not itself rewriting (decision 9). `session` is the detection cache —
 * page-derived, never written to disk, gone when the browser closes (see
 * `lib/detection.ts`).
 */
function createArea() {
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
        for (const [key, newValue] of Object.entries(items)) store[key] = newValue
      },
      async remove(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]
      },
      async clear() {
        store = {}
      },
    },
  }
}

function createStorageStub() {
  const local = createArea()
  const session = createArea()

  return {
    reset() {
      local.clear()
      session.clear()
    },
    local: local.api,
    session: session.api,
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

/**
 * `onMessage` and `getManifest` exist for the panel's sake.
 *
 * `App` installs a broadcast listener on mount and reads the version for its
 * header, so without these a test of the panel fails on a missing global before
 * it reaches anything it was written to check. The listener set is real rather
 * than a bare spy because the panel's own behaviour on a broadcast — retiring a
 * prompt, re-reading a tab — is worth being able to drive from a test.
 */
const messageListeners = new Set<(message: unknown) => void>()

const runtime = {
  sendMessage: vi.fn(async () => undefined),
  getManifest: vi.fn(() => ({ version: '0.0.1-test' })),
  getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
  onMessage: {
    addListener: (listener: (message: unknown) => void) => messageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) =>
      messageListeners.delete(listener),
  },
}

/** Delivers a broadcast to whatever is listening, as the worker would. */
export function emitMessage(message: unknown): void {
  for (const listener of [...messageListeners]) listener(message)
}

/**
 * Just enough `chrome.tabs` for the panel to find out which tab it sits beside.
 *
 * Only `id` is ever returned, which is the whole of what decision 2 permits
 * without the `tabs` permission — a stub that handed back a `url` would let a
 * test pass against code that could not work in a real browser.
 */
const tabs = {
  query: vi.fn(async () => [{ id: 7 }]),
  onActivated: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
}

/**
 * Injection, as a spy. Resolving by default because that is the ordinary case;
 * the refusals worth testing — a `chrome://` page, the Web Store, a PDF — are
 * made explicit per test.
 */
const scripting = {
  executeScript: vi.fn(async () => [] as unknown[]),
}

vi.stubGlobal('chrome', {
  storage: {
    local: storage.local,
    session: storage.session,
  },
  runtime,
  tabs,
  action,
  scripting,
})

beforeEach(() => {
  storage.reset()
  messageListeners.clear()
  action.setBadgeText.mockClear()
  action.setBadgeBackgroundColor.mockClear()
  runtime.sendMessage.mockClear()
  tabs.query.mockClear()
  scripting.executeScript.mockClear()
})
