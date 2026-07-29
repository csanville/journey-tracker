import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchUrl, type WatchOptions } from './watch-url'

/**
 * A stand-in for the window, so the watcher can be driven without a browser.
 *
 * Deliberately not a jsdom window: the point of these tests is which *signals*
 * the watcher is subscribed to and what it does when each one fires, and a real
 * window would supply some of them for free and hide which.
 */
function fakeTarget() {
  const listeners = new Map<string, Set<EventListener>>()

  return {
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener)
    },
    fire(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(new Event(type))
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

function setup(initial: string, extra: Partial<WatchOptions> = {}) {
  let href = initial
  const target = fakeTarget()
  const navigation = fakeTarget()
  const seen: string[] = []

  const watcher = watchUrl((url) => seen.push(url), {
    readHref: () => href,
    target,
    navigation,
    ...extra,
  })

  return {
    target,
    navigation,
    seen,
    watcher,
    goTo(url: string) {
      href = url
    },
  }
}

describe('watchUrl', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says nothing about the URL it started on', () => {
    // The caller already handled that one; reporting it would parse the first
    // posting twice.
    const { seen, watcher } = setup('https://jobs.example/a')

    vi.advanceTimersByTime(5000)
    watcher.stop()

    expect(seen).toEqual([])
  })

  it('notices a pushState-style change that fires no event at all', () => {
    // The case the poll exists for. A content script cannot patch
    // `history.pushState` — it runs in an isolated world, so the function it
    // would patch is not the one the page calls — and `pushState` fires neither
    // `popstate` nor `hashchange`.
    const { seen, goTo, watcher } = setup('https://jobs.example/a')

    goTo('https://jobs.example/b')
    expect(seen).toEqual([])

    vi.advanceTimersByTime(1000)
    watcher.stop()

    expect(seen).toEqual(['https://jobs.example/b'])
  })

  it('reports a change immediately on popstate rather than waiting for the poll', () => {
    const { target, seen, goTo, watcher } = setup('https://jobs.example/a')

    goTo('https://jobs.example/b')
    target.fire('popstate')
    watcher.stop()

    expect(seen).toEqual(['https://jobs.example/b'])
  })

  it('reports a change on hashchange and on the Navigation API', () => {
    const first = setup('https://jobs.example/a')
    first.goTo('https://jobs.example/b')
    first.target.fire('hashchange')
    first.watcher.stop()

    const second = setup('https://jobs.example/a')
    second.goTo('https://jobs.example/c')
    second.navigation.fire('navigatesuccess')
    second.watcher.stop()

    expect(first.seen).toEqual(['https://jobs.example/b'])
    expect(second.seen).toEqual(['https://jobs.example/c'])
  })

  it('reports one navigation once, however many signals describe it', () => {
    // Three overlapping sources is the whole design; three callbacks for one
    // navigation would make the content script re-parse and re-report a page
    // it had already handled.
    const { target, navigation, seen, goTo, watcher } = setup('https://jobs.example/a')

    goTo('https://jobs.example/b')
    target.fire('popstate')
    navigation.fire('navigatesuccess')
    vi.advanceTimersByTime(3000)
    watcher.stop()

    expect(seen).toEqual(['https://jobs.example/b'])
  })

  it('keeps up with a run of navigations', () => {
    const { target, seen, goTo, watcher } = setup('https://jobs.example/a')

    goTo('https://jobs.example/b')
    target.fire('popstate')
    goTo('https://jobs.example/c')
    target.fire('popstate')
    goTo('https://jobs.example/b')
    target.fire('popstate')
    watcher.stop()

    // Back to /b is a real navigation, not a duplicate — dedupe is against the
    // last reported URL, not against everything ever seen.
    expect(seen).toEqual([
      'https://jobs.example/b',
      'https://jobs.example/c',
      'https://jobs.example/b',
    ])
  })

  it('works without a Navigation API', () => {
    let href = 'https://jobs.example/a'
    const target = fakeTarget()
    const seen: string[] = []
    const watcher = watchUrl((url) => seen.push(url), {
      readHref: () => href,
      target,
      navigation: null,
    })

    href = 'https://jobs.example/b'
    vi.advanceTimersByTime(1000)
    watcher.stop()

    expect(seen).toEqual(['https://jobs.example/b'])
  })

  it('unsubscribes everything when stopped', () => {
    const { target, navigation, seen, goTo, watcher } = setup('https://jobs.example/a')

    watcher.stop()
    goTo('https://jobs.example/b')
    target.fire('popstate')
    navigation.fire('navigatesuccess')
    vi.advanceTimersByTime(10_000)

    expect(seen).toEqual([])
    expect(target.count('popstate')).toBe(0)
    expect(target.count('hashchange')).toBe(0)
    expect(navigation.count('navigatesuccess')).toBe(0)
    // And the poll is actually cancelled, not merely made ineffective by the
    // `stopped` flag. A timer left running on every job page for the life of
    // the tab is a leak no assertion about the callback would ever notice.
    expect(vi.getTimerCount()).toBe(0)
  })
})
