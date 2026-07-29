/**
 * JourneyTracker service worker — the single writer.
 *
 * Every mutation in the extension arrives here as a message, so dedupe, schema
 * version and normalization invariants are enforced in one place rather than
 * raced between however many panels happen to be open (decision 4).
 */
import { openDb, type JourneyTrackerDb } from '../lib/db'
import { forgetTab } from '../lib/detection'
import { handleRequest } from '../lib/handler'
import { allowedFromContentScript, isRequest } from '../lib/messages'
import { runPendingMigrations } from '../lib/migrations'
import { recordStorageProtection } from '../lib/persistence'

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

    try {
      await runPendingMigrations(db)
      // Assessed once per worker lifetime rather than only at install, so the
      // reported value cannot go stale after a permission change or a Chrome
      // decision that went the other way.
      await recordStorageProtection()
    } catch (error) {
      // Close the connection we opened before letting the failure through.
      // Retrying opens another, and a pile of live connections would block the
      // `versionchange` upgrade of any later release that adds an index.
      db.close()
      throw error
    }

    return db
  })().catch((error: unknown) => {
    // Do not cache a failed start, or the worker stays broken until Chrome
    // decides to recycle it.
    readyPromise = null
    throw error
  })

  return readyPromise
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    try {
      // Without this the toolbar button does nothing and the panel can only be
      // reached from Chrome's own side-panel menu.
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
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

/**
 * A tab's detection is only useful while the tab exists, and
 * `chrome.storage.session` is a shared 10MB budget. Cleaning up here means the
 * cache's own eviction bound is a backstop rather than the only thing keeping
 * it from filling with closed tabs. No permission is needed for this listener —
 * `onRemoved` reports an id, not a URL.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTab(tabId).catch((error: unknown) => {
    console.error('[JourneyTracker] could not forget tab', tabId, error)
  })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRequest(message)) return false

  // `sender.tab` is set exactly when the sender is a content script. The panel
  // and the worker's own callers have no tab, and nothing in the extension
  // needs a content script to be able to write or delete records.
  const fromContentScript = sender.tab !== undefined
  if (fromContentScript && !allowedFromContentScript(message.kind)) {
    sendResponse({ ok: false, error: `not available to content scripts: ${message.kind}` })
    return false
  }

  void (async () => {
    try {
      sendResponse(await handleRequest(await ready(), message, { tabId: sender.tab?.id }))
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
