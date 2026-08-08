/**
 * Serializing read-modify-write against `chrome.storage`.
 *
 * `chrome.storage` is asynchronous, so a read and the write that depends on it
 * are two turns with a gap between them, and the worker is free to service
 * another message in that gap. Two tabs reporting at once is not a rare
 * interleaving to reason about — it is what happens every time somebody
 * middle-clicks two postings from a search page, because both content scripts
 * fire their first attempt on the same timer. Interleaved, the second write
 * lands on a snapshot taken before the first, and one tab's entry disappears
 * with nothing in any console.
 *
 * A promise chain is enough. The worker is single-threaded, so the only
 * concurrency is this — awaits interleaving inside one thread — and queueing the
 * whole read-modify-write behind the previous one removes it.
 *
 * Extracted from `detection.ts` in phase 10, when `pending.ts` turned out to
 * need the identical guarantee over a different key. **Each caller gets its own
 * queue**, which is the point of the factory: two stores that never touch the
 * same key have no reason to wait on each other, and a single shared chain would
 * make a slow detection write block an unrelated prompt from being retired.
 */
export function createSerializer(): <T>(operation: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve()

  return function serialized<T>(operation: () => Promise<T>): Promise<T> {
    // The failure of one operation must not poison the queue for the next, so
    // the chain is continued from a settled promise rather than the returned
    // one.
    const result = queue.then(operation, operation)
    queue = result.catch(() => undefined)

    return result
  }
}
