/**
 * JourneyTracker service worker — the single writer.
 *
 * Every mutation in the extension arrives here as a message, so dedupe, schema
 * version and normalization invariants are enforced in one place rather than
 * raced between however many panels happen to be open (decision 4).
 */
import { openDb, type JourneyTrackerDb } from '../lib/db'
import { handleRequest } from '../lib/handler'
import { isRequest } from '../lib/messages'
import { runPendingMigrations } from '../lib/migrations'
import { ensurePersistentStorage } from '../lib/persistence'
import { patchSettings } from '../lib/settings'

let readyPromise: Promise<JourneyTrackerDb> | null = null

/**
 * Opens the database and brings it up to date, once per worker lifetime.
 *
 * Gated on every request rather than left to `onInstalled`, because the worker
 * is torn down when idle and a restarted one would otherwise serve requests
 * against a database nothing had migrated in this lifetime.
 */
function ready(): Promise<JourneyTrackerDb> {
  readyPromise ??= (async () => {
    const db = await openDb()
    await runPendingMigrations(db)
    return db
  })().catch((error: unknown) => {
    // Do not cache a failed start, or the worker stays broken until Chrome
    // decides to recycle it.
    readyPromise = null
    throw error
  })

  return readyPromise
}

/**
 * Records are useless if the browser evicts them, and there is no telemetry
 * that would ever reveal the loss — so ask, and record the answer where the UI
 * can warn about it (decision 3).
 */
async function recordStoragePersistence(): Promise<void> {
  const persisted = await ensurePersistentStorage()
  await patchSettings({ storagePersisted: persisted })
  if (!persisted) {
    console.warn(
      '[JourneyTracker] persistent storage was not granted — records are evictable',
    )
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    try {
      // Without this the toolbar button does nothing and the panel can only be
      // reached from Chrome's own side-panel menu.
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      await recordStoragePersistence()
      await ready()
    } catch (error) {
      console.error('[JourneyTracker] install failed', error)
    }
  })()
})

chrome.runtime.onStartup.addListener(() => {
  void ready().catch((error: unknown) => {
    console.error('[JourneyTracker] startup failed', error)
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRequest(message)) return false

  void (async () => {
    try {
      sendResponse(await handleRequest(await ready(), message))
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })()

  // Keeps the message channel open for the async response above.
  return true
})
