import { describe, expect, it, vi } from 'vitest'
import { INJECTED_FILE, captureTab } from './capture'

describe('captureTab', () => {
  it('injects into the tab it was given', async () => {
    const captured = await captureTab(42)

    expect(captured).toBe(true)
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: [INJECTED_FILE],
    })
  })

  it('injects the self-contained bundle, not the declared content script', async () => {
    // The declared script is compiled to a loader that dynamically imports the
    // real module, and that import is only permitted from the three origins in
    // `web_accessible_resources`. Injecting it into an unknown site — the only
    // place this feature is ever used — would fail at the import, silently, in
    // a page console nobody is reading.
    await captureTab(42)

    const [call] = vi.mocked(chrome.scripting.executeScript).mock.calls
    expect(call?.[0].files).toEqual(['injected.js'])
    expect(call?.[0].files?.[0]).not.toContain('content-script')
  })

  it('reports a refusal rather than throwing', async () => {
    // A `chrome://` page, the Web Store, a PDF viewer. All refuse injection
    // whatever is granted, all are things a user will right-click on, and none
    // is a fault to raise a dialog about.
    vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(
      new Error('Cannot access contents of the page'),
    )

    await expect(captureTab(42)).resolves.toBe(false)
  })

  it('uses a fixed filename the worker can name without a hash', async () => {
    // Everything else in the build is content-hashed and resolved through the
    // manifest. This one is named directly, which is why `vite.inject.config.ts`
    // pins it.
    expect(INJECTED_FILE).toBe('injected.js')
    expect(INJECTED_FILE).not.toMatch(/-[A-Za-z0-9_-]{8}\./)
  })
})
