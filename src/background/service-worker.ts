/**
 * JourneyTracker service worker — the single writer.
 *
 * Every mutation in the extension arrives here as a message, so dedupe, schema
 * version and normalization invariants are enforced in one place rather than
 * raced between however many panels happen to be open (decision 4).
 */
import { openDb, type JourneyTrackerDb } from '../lib/db'
import { captureTab } from '../lib/capture'
import { forgetTab } from '../lib/detection'
import { broadcast } from '../lib/events'
import { handleRequest } from '../lib/handler'
import { allowedFromContentScript, isRequest } from '../lib/messages'
import { resumeImportMigration, runPendingMigrations } from '../lib/migrations'
import { recordStorageProtection } from '../lib/persistence'
import { setTrackedBadge } from '../lib/tracked'

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
      // An import of a backup written by an older build records how far behind
      // its records were and migrates them at the end. This is what finishes
      // the job when there was no end — a panel closed mid-import, a batch that
      // failed, a worker killed between two steps of the chain. A no-op on
      // every ordinary start, which is all of them.
      await resumeImportMigration(db)
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

/**
 * The right-click entry point, and the reason it is a right-click.
 *
 * `activeTab` is granted by four gestures and no others: an action, a context
 * menu item, a `commands` shortcut, an omnibox suggestion. A button in the side
 * panel grants nothing, so the obvious affordance — next to the form, where
 * somebody would look — cannot work. The action is spoken for as well, since
 * `openPanelOnActionClick` means clicking the icon opens the panel and
 * `onClicked` never fires.
 *
 * That leaves the context menu and the keyboard shortcut, and both are wired
 * below. The menu is the discoverable one.
 */
const CAPTURE_MENU_ID = 'journeytracker-capture'

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    try {
      // Without this the toolbar button does nothing and the panel can only be
      // reached from Chrome's own side-panel menu.
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

      // Removed first so a reload during development does not accumulate
      // duplicates of the same item, which `create` would reject.
      await chrome.contextMenus.removeAll()
      chrome.contextMenus.create({
        id: CAPTURE_MENU_ID,
        title: 'Read this page into JourneyTracker',
        // `page` only. Offering this on a link or an image would promise
        // something `activeTab` cannot deliver — the grant is for the tab in
        // front of the user, not for whatever a link points at.
        contexts: ['page'],
      })

      await ready()
    } catch (error) {
      console.error('[JourneyTracker] install failed', error)
    }
  })()
})

// Both listeners call straight through, with nothing awaited in between. The
// user activation that `sidePanel.open` needs belongs to this event and does not
// outlive the first `await` — see `captureAndShow`.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CAPTURE_MENU_ID || tab?.id === undefined) return

  captureAndShow(tab.id)
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'capture-page' || tab?.id === undefined) return

  captureAndShow(tab.id)
})

/**
 * Shows the panel, then reads the tab into it.
 *
 * The order is not a preference. `sidePanel.open` may only be called while the
 * gesture that invoked it is still live, and user activation does not survive an
 * `await` — so opening the panel *after* the `executeScript` round trip, however
 * briefly, meant `open` rejecting with "may only be called in response to a user
 * gesture" every single time. Right-clicking a page read it and then appeared to
 * do nothing, because the rejection landed in a `console.debug` in a worker
 * nobody has inspected. Nothing is awaited before the `open` call now, and
 * nothing may be.
 *
 * The cost of that ordering is that the panel also opens when the read is
 * refused — a PDF, the Web Store, a `chrome://` page. That is the lesser of the
 * two: an empty panel is a visible answer to a request, and the panel says what
 * it means when it has nothing (see `App.tsx`), whereas no panel at all is
 * indistinguishable from a broken menu item.
 */
function captureAndShow(tabId: number): void {
  // First, and synchronously.
  chrome.sidePanel.open({ tabId }).catch((error: unknown) => {
    // Already open, or a window Chrome will not attach a panel to.
    console.debug('[JourneyTracker] could not open the panel', error)
  })

  void captureTab(tabId)
}

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

/**
 * A tab navigating away invalidates whatever was detected on it.
 *
 * This mattered less in phase 4, where a stale detection meant a banner
 * offering a page the user had left and could be ignored. Now that a pristine
 * form fills itself, a detection that outlives its page would put the previous
 * job into the form on an unrelated site — silently, and looking exactly like a
 * correct read.
 *
 * Gated on `status === 'loading'`, which is a real page load. Single-page
 * navigation does not set it, and must not: Workday and Ashby change the URL
 * without a load, `watch-url.ts` re-reports when they do, and clearing on those
 * would delete a detection that is about to be replaced by an identical one.
 *
 * No permission. Without `tabs`, `onUpdated` still fires and still carries
 * `status`; it is `url`, `title` and `favIconUrl` that are withheld, and none of
 * those is wanted here (decision 2).
 *
 * Everything after the `forgetTab` is gated on it having found something,
 * because this listener is global in a way the others are not. `onRemoved` fires
 * when a tab closes, which is rare; this fires on every navigation in every tab,
 * so a user reading the news wakes the worker on each page load — and decision 9
 * is built on the worker being idle enough to be torn down. Ungated, each of
 * those wakeups also painted a badge and broadcast an event, and the broadcast
 * made every open panel do a full `detection/get` round trip about a tab it has
 * never heard of. Gated, an uninteresting navigation costs one session-storage
 * read and stops.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return

  void (async () => {
    try {
      const forgotten = await forgetTab(tabId)
      // Nothing was being held, so nothing is now false. This is the gate that
      // keeps an uninteresting navigation to one session-storage read.
      if (!forgotten.detection && !forgotten.diagnostic) return

      // Only a detection ever painted a badge, so only a detection calls for it
      // to be repainted. A dropped diagnostic still owes the panel the broadcast
      // below — it renders from either, and a report naming a page the tab has
      // left is the stale claim this listener exists to prevent.
      if (forgotten.detection) {
        // The page that earned the mark is gone. A content script on whatever
        // loads next will re-earn it.
        await setTrackedBadge(tabId, false)
      }
    } catch (error) {
      console.error('[JourneyTracker] could not clear tab', tabId, error)
      return
    }

    await broadcast({ type: 'detection/changed', tabId })
  })()
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
