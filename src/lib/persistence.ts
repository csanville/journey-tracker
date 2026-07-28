/**
 * IndexedDB defaults to best-effort storage, which Chrome evicts by
 * least-recently-used under disk pressure — the whole origin at once, not just
 * the excess. `unlimitedStorage` lifts the quota but makes no eviction promise;
 * quota and eviction are separate concerns.
 *
 * Since a job-search history exists nowhere else, and there is no telemetry
 * that would ever reveal the loss, asking for persistent storage is a
 * requirement rather than a nicety (decision 3).
 */

/**
 * Requests persistent storage, returning whether the data is now protected.
 *
 * Chrome decides automatically based on engagement rather than prompting, so a
 * `false` here is a real answer, not a pending one — the caller should surface
 * it rather than retrying in a loop.
 */
export async function ensurePersistentStorage(): Promise<boolean> {
  const storage = navigator.storage as StorageManager | undefined
  if (!storage?.persist || !storage.persisted) return false

  try {
    if (await storage.persisted()) return true
    return await storage.persist()
  } catch {
    // Treat an unavailable API the same as a refusal: the caller's job is to
    // tell the user their data is evictable, and it is.
    return false
  }
}
