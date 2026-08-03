import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The capture gesture, tested for its *ordering* rather than its effects.
 *
 * `chrome.sidePanel.open` may only be called while the gesture that invoked it
 * is still live, and user activation does not survive an `await`. That makes the
 * order of two calls the entire correctness condition here, and it is invisible
 * in a diff: the first version of this awaited the injection and then opened the
 * panel, which reads perfectly well and failed every time, with the rejection
 * landing in a `console.debug` in a worker console.
 *
 * So these assertions are deliberately made *before* awaiting anything. A test
 * that awaited first would pass against both versions.
 */

type Listener = (...args: never[]) => unknown

function slot() {
  const listeners: Listener[] = []

  return {
    fire: (...args: unknown[]) => listeners[0]?.(...(args as never[])),
    addListener: (listener: Listener) => listeners.push(listener),
    removeListener: () => undefined,
  }
}

const menu = slot()
const command = slot()

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    ...chrome,
    sidePanel: {
      open: vi.fn(async () => undefined),
      setPanelBehavior: vi.fn(async () => undefined),
    },
    contextMenus: {
      onClicked: menu,
      create: vi.fn(),
      removeAll: vi.fn(async () => undefined),
    },
    commands: { onCommand: command },
    tabs: { onRemoved: slot(), onUpdated: slot() },
    runtime: {
      ...chrome.runtime,
      onInstalled: slot(),
      onStartup: slot(),
      onMessage: slot(),
    },
  })

  // Imported for its side effect: the listeners register at module scope, which
  // is what an MV3 worker requires — a listener added later than the first turn
  // is not there when Chrome wakes the worker to deliver an event.
  await import('./service-worker')
})

beforeEach(() => {
  vi.mocked(chrome.sidePanel.open).mockClear()
})

describe('the capture gesture', () => {
  it('opens the panel before it awaits anything', () => {
    // Not awaited. At this point the injection has been started and has not
    // resolved, and the panel must already have been asked for — the previous
    // version reached this line having called nothing but `executeScript`.
    menu.fire({ menuItemId: 'journeytracker-capture' }, { id: 7 })

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 })
  })

  it('asks for the panel before it asks for the page', () => {
    menu.fire({ menuItemId: 'journeytracker-capture' }, { id: 7 })

    const [opened] = vi.mocked(chrome.sidePanel.open).mock.invocationCallOrder
    const executed = vi
      .mocked(chrome.scripting.executeScript)
      .mock.invocationCallOrder.at(-1)

    expect(opened).toBeLessThan(executed!)
  })

  it('opens the panel from the keyboard shortcut too', () => {
    command.fire('capture-page', { id: 9 })

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 9 })
  })

  it('still opens the panel when the page refuses to be read', async () => {
    // A PDF, the Web Store, a `chrome://` page. The read is lost either way, and
    // this is the cost of opening first: the panel appears with nothing in it.
    // An empty panel is a visible answer to the request; no panel is
    // indistinguishable from a menu item that does not work.
    vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(
      new Error('Cannot access contents of the page'),
    )

    command.fire('capture-page', { id: 9 })
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalled())

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 9 })
  })

  it('ignores a context menu item that is not ours', () => {
    menu.fire({ menuItemId: 'something-else' }, { id: 7 })

    expect(chrome.sidePanel.open).not.toHaveBeenCalled()
  })

  it('ignores a gesture with no tab behind it', () => {
    menu.fire({ menuItemId: 'journeytracker-capture' }, undefined)
    command.fire('capture-page', undefined)

    expect(chrome.sidePanel.open).not.toHaveBeenCalled()
  })
})
