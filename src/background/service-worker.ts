/**
 * JourneyTracker service worker.
 *
 * Phase 0 does one thing: make the toolbar button open the side panel. Tab
 * tracking and extraction messaging arrive in later phases.
 */

chrome.runtime.onInstalled.addListener(() => {
  // Without this, clicking the action does nothing and the panel can only be
  // opened from Chrome's own side-panel menu.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.error('[JourneyTracker] could not set panel behavior', error)
    })
})
