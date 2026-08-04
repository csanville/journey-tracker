/**
 * Remembering which tab the dashboard is in, without the `tabs` permission.
 *
 * The obvious implementation is `chrome.tabs.query({ url })`, and it does not
 * work here: the `url` filter is ignored unless the extension holds `tabs` or a
 * host permission matching it, and decision 2 keeps the manifest free of both.
 * It does not fail loudly either — the query resolves to an empty array, which
 * is indistinguishable from "no dashboard open", so every click would open
 * another tab and each one would hold its own `liveQuery` over the whole record
 * set.
 *
 * What does work without any permission is `tabs.getCurrent()`, which an
 * extension page may always call about itself, and `tabs.update(id, …)`, which
 * is not permission-gated. So the dashboard registers its own tab id and the
 * panel focuses it. `chrome.storage.session` is the right home for it: the id is
 * meaningless once the browser restarts, and it is not something to write to
 * disk (see `lib/detection.ts`, which is scoped the same way and for the same
 * reason).
 */

const KEY = 'dashboardTabId'

async function setDashboardTabId(id: number): Promise<void> {
  await chrome.storage.session.set({ [KEY]: id })
}

/**
 * Called by the dashboard on load, about itself.
 *
 * `openDashboard` already registers the tab it creates, so this is the backstop
 * rather than the main path: it covers a tab Chrome restored across a browser
 * restart, which has an id nobody recorded because `chrome.storage.session` was
 * cleared underneath it.
 */
export async function registerDashboardTab(): Promise<void> {
  const tab = await chrome.tabs.getCurrent()
  if (tab?.id === undefined) return

  await setDashboardTabId(tab.id)
}

export async function getDashboardTabId(): Promise<number | null> {
  const stored = await chrome.storage.session.get(KEY)
  const id = stored[KEY]

  return typeof id === 'number' ? id : null
}

export async function forgetDashboardTab(): Promise<void> {
  await chrome.storage.session.remove(KEY)
}

export const DASHBOARD_PATH = 'src/dashboard/index.html'

/**
 * In-flight `openDashboard`, so two clicks cannot both decide to open a tab.
 *
 * The check-then-create in `open` spans two awaits, and a second click landing
 * between them reads the same empty session storage the first one did. Sharing
 * one promise is enough because a panel is a single JavaScript context — there
 * is no second one racing it, and if the panel is torn down mid-flight the tab
 * has already been created and registered.
 */
let opening: Promise<void> | null = null

/**
 * Focuses the dashboard if it is open, and opens it otherwise.
 *
 * The stored id can be stale in the ordinary course of things — the user closed
 * the tab, or the browser restarted — and `tabs.update` rejects on an id that no
 * longer exists. That rejection is the signal to open a fresh one, not an error
 * worth reporting.
 */
export async function openDashboard(): Promise<void> {
  opening ??= open().finally(() => {
    opening = null
  })

  return opening
}

async function open(): Promise<void> {
  const url = chrome.runtime.getURL(DASHBOARD_PATH)
  const existing = await getDashboardTabId()

  if (existing !== null) {
    try {
      const tab = await chrome.tabs.update(existing, { active: true })
      if (tab?.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true })
      }
      return
    } catch {
      // Closed since it registered. Fall through and open a new one.
      await forgetDashboardTab()
    }
  }

  // Registered here, from the id `tabs.create` hands back, rather than left to
  // the new tab's own `registerDashboardTab`. That runs after the bundle has
  // loaded and React has mounted, and until it does the session storage still
  // reads empty — so a click in that window would open a second tab, each one
  // holding its own `liveQuery` over the whole record set. The tab announces
  // itself as well, which covers the ids this path never sees (decision 17).
  const created = await chrome.tabs.create({ url })
  if (created?.id !== undefined) await setDashboardTabId(created.id)
}
