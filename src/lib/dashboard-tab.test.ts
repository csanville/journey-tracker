import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DASHBOARD_PATH,
  getDashboardTabId,
  openDashboard,
  registerDashboardTab,
} from './dashboard-tab'

const tabs = {
  getCurrent: vi.fn(async () => ({ id: 7, windowId: 1 })),
  update: vi.fn(async (id: number) => ({ id, windowId: 1 })),
  create: vi.fn(async () => ({ id: 9, windowId: 1 })),
}
const windows = { update: vi.fn(async () => ({})) }

beforeEach(() => {
  vi.stubGlobal('chrome', {
    ...chrome,
    tabs,
    windows,
    runtime: {
      ...chrome.runtime,
      getURL: (path: string) => `chrome-extension://abc/${path}`,
    },
  })
  tabs.getCurrent.mockClear()
  tabs.update.mockClear()
  tabs.create.mockClear()
  windows.update.mockClear()
})

describe('registerDashboardTab', () => {
  it('records the tab it is running in', async () => {
    await registerDashboardTab()

    expect(await getDashboardTabId()).toBe(7)
  })

  it('records nothing when Chrome will not say which tab this is', async () => {
    tabs.getCurrent.mockResolvedValueOnce(undefined as never)

    await registerDashboardTab()

    expect(await getDashboardTabId()).toBeNull()
  })
})

describe('openDashboard', () => {
  it('opens a tab when none is registered', async () => {
    await openDashboard()

    expect(tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://abc/${DASHBOARD_PATH}`,
    })
  })

  it('focuses the tab already open instead of opening a second one', async () => {
    // Each dashboard tab holds its own liveQuery over the whole record set, so
    // piling them up is not only untidy.
    await registerDashboardTab()

    await openDashboard()

    expect(tabs.update).toHaveBeenCalledWith(7, { active: true })
    expect(windows.update).toHaveBeenCalledWith(1, { focused: true })
    expect(tabs.create).not.toHaveBeenCalled()
  })

  it('opens a new tab when the registered one has been closed', async () => {
    // `tabs.update` rejects on an id that no longer exists. That is the ordinary
    // course of things — the user closed the tab — not an error to report.
    await registerDashboardTab()
    tabs.update.mockRejectedValueOnce(new Error('No tab with id: 7.'))

    await openDashboard()

    expect(tabs.create).toHaveBeenCalledOnce()
  })

  it('forgets a closed tab rather than retrying it forever', async () => {
    await registerDashboardTab()
    tabs.update.mockRejectedValueOnce(new Error('No tab with id: 7.'))
    await openDashboard()

    expect(await getDashboardTabId()).toBeNull()
  })
})
