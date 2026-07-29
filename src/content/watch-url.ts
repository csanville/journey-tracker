/**
 * Noticing that the page became a different posting without reloading.
 *
 * The roadmap called for "patched `pushState`/`replaceState`, `popstate`, or the
 * Navigation API". The first of those **cannot work from a content script**, and
 * finding out why is the main thing this file records.
 *
 * A content script runs in an isolated world: same DOM, different JavaScript
 * heap. `History.prototype.pushState` in that world is not the one the page
 * calls, so patching it intercepts nothing. The usual fix is a `world: "MAIN"`
 * injection, which puts extension code in the page's own context — a real
 * escalation of what the extension is doing on the page, for a signal that can
 * be had another way.
 *
 * So what is left is:
 *
 * - `popstate` and `hashchange`, which are genuine window events and do reach
 *   the isolated world — but `pushState` fires neither, and `pushState` is how
 *   an SPA moves between postings.
 * - The Navigation API's `navigatesuccess`, which does cover `pushState`. It is
 *   used when present, and it is *not* trusted as sufficient: whether
 *   `window.navigation` in an isolated world observes the page's own
 *   same-document navigations has not been verified in a browser here, and
 *   decision 3's recurring lesson on this project is that a mechanism recorded
 *   as working when only its existence was checked is how silent failures ship.
 * - A poll of `location.href`. Crude, unconditionally correct, and the reason
 *   the honest answer to "did it notice?" is yes. One property read per second
 *   is not a cost worth optimising away for a guarantee this size.
 *
 * When the Navigation API is confirmed to fire here, the poll can slow down or
 * go. Until then it is the backstop that makes the other two optimisations.
 */

/** Slow enough to be free, fast enough that the panel is never visibly stale. */
export const POLL_INTERVAL_MS = 1000

export interface WatchOptions {
  /** Reads the current URL. Injected so this is testable without a browser. */
  readHref?: () => string
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  /** The Navigation API object, when the runtime has one. */
  navigation?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  pollIntervalMs?: number
}

export interface UrlWatcher {
  stop(): void
  /** The URL last reported. Exposed for the content script's own bookkeeping. */
  current(): string
}

/**
 * Calls `onChange` whenever the URL becomes something other than what was last
 * reported.
 *
 * Deduplicated against the last *reported* value rather than per-source, so the
 * three overlapping signals above cannot produce three callbacks for one
 * navigation. Never fires for the initial URL — the caller already has that one
 * and would otherwise handle its first posting twice.
 */
export function watchUrl(
  onChange: (url: string) => void,
  options: WatchOptions = {},
): UrlWatcher {
  const readHref = options.readHref ?? (() => globalThis.location.href)
  const target = options.target ?? globalThis.window
  const navigation =
    options.navigation === undefined
      ? ((globalThis as { navigation?: EventTarget }).navigation ?? null)
      : options.navigation
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS

  let last = readHref()
  let stopped = false

  const check = () => {
    if (stopped) return

    const href = readHref()
    if (href === last) return

    last = href
    onChange(href)
  }

  target.addEventListener('popstate', check)
  target.addEventListener('hashchange', check)
  navigation?.addEventListener('navigatesuccess', check)

  const timer = setInterval(check, interval)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      target.removeEventListener('popstate', check)
      target.removeEventListener('hashchange', check)
      navigation?.removeEventListener('navigatesuccess', check)
    },
    current: () => last,
  }
}
