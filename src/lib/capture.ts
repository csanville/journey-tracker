/**
 * Putting the reader onto a tab the user has just granted.
 *
 * The gesture is the permission. `activeTab` is granted by exactly four things
 * — executing an action, a context menu item, a keyboard shortcut from the
 * `commands` API, or an omnibox suggestion — and by nothing else. A button
 * inside the side panel is **not** one of them, which is the single most
 * important fact about this feature and the reason the affordance lives in the
 * right-click menu rather than next to the form where it would be easier to
 * find.
 *
 * The toolbar icon is not usable either, for a second reason: the manifest sets
 * `openPanelOnActionClick`, so clicking the icon opens the side panel and
 * `action.onClicked` never fires. That is the behaviour worth having for the
 * icon, so the gesture had to go somewhere else.
 */

/**
 * The injected bundle, by name.
 *
 * Fixed rather than content-hashed, and built by `vite.inject.config.ts` for
 * that reason. The declared content script's path *is* hashed, which is why
 * nothing here hardcodes it — but the declared script is also the wrong thing to
 * inject. See `content/injected.ts`.
 */
export const INJECTED_FILE = 'injected.js'

/**
 * Reads one tab, once, on the strength of a gesture the user just made.
 *
 * Reports success rather than throwing. Every caller is an event handler with
 * nowhere to report to, and the failures are ordinary: a tab on
 * `chrome://extensions`, the Chrome Web Store, or a PDF viewer will refuse
 * injection no matter what is granted, and none of those is a bug to be fixed
 * or a dialog worth raising.
 *
 * Nothing is returned about the page. The injected script reports through the
 * same `detection/report` message the declared one uses, so the worker caches
 * it, the badge lights, and the panel hears about it by the ordinary route —
 * this function's only job is to get the reader onto the page.
 */
export async function captureTab(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [INJECTED_FILE],
    })

    return true
  } catch (error) {
    // Expected on restricted pages. Logged at debug rather than error because
    // right-clicking on a page the extension cannot read is a thing users will
    // do, not a fault.
    console.debug('[JourneyTracker] could not read this tab', tabId, error)

    return false
  }
}
