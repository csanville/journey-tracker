/**
 * Keeping records out of reach of Chrome's eviction.
 *
 * IndexedDB defaults to best-effort storage, which Chrome evicts by
 * least-recently-used under disk pressure — the whole origin at once, not just
 * the excess. Since a job-search history exists nowhere else and no telemetry
 * would ever reveal the loss, this is the project's worst failure mode
 * (decision 3).
 *
 * Chrome's storage guide gives extensions two defences, and they are not
 * equivalent:
 *
 *   > Request the "unlimitedStorage" permission, which affects both extension
 *   > and web storage APIs and exempts extensions from both quota restrictions
 *   > and eviction.
 *   > Call navigator.storage.persist() for protection against eviction.
 *
 * `unlimitedStorage` is the stronger of the two for an extension: it is granted
 * at install rather than judged against engagement heuristics, so it does not
 * quietly refuse the way `persist()` does on a freshly installed extension.
 * Both are used — either one alone is sufficient, and asking for both costs
 * nothing.
 */

export interface StorageProtection {
  /** `unlimitedStorage` granted — exempt from quota *and* eviction. */
  unlimited: boolean
  /** What `navigator.storage.persist()` answered. */
  persisted: boolean
  /** Records are safe from LRU eviction if either defence holds. */
  evictionSafe: boolean
}

/**
 * Whether `unlimitedStorage` is actually granted, rather than merely declared.
 * Asked of the permissions API first because a manifest entry is a request, not
 * proof; the manifest is only a fallback for contexts where that API is absent.
 */
async function hasUnlimitedStorage(): Promise<boolean> {
  try {
    if (chrome.permissions?.contains) {
      return await chrome.permissions.contains({ permissions: ['unlimitedStorage'] })
    }
  } catch {
    // Fall through to the manifest.
  }

  try {
    return chrome.runtime.getManifest().permissions?.includes('unlimitedStorage') ?? false
  } catch {
    return false
  }
}

async function requestPersistence(): Promise<boolean> {
  const storage = navigator.storage as StorageManager | undefined
  if (!storage?.persist || !storage.persisted) return false

  try {
    if (await storage.persisted()) return true
    return await storage.persist()
  } catch {
    return false
  }
}

/**
 * Establishes and reports how well protected stored records are.
 *
 * A `false` from `persist()` is a real answer rather than a pending one —
 * Chrome decides on engagement heuristics instead of prompting — so callers
 * should report the result rather than retry in a loop.
 */
export async function assessStorageProtection(): Promise<StorageProtection> {
  const [unlimited, persisted] = await Promise.all([
    hasUnlimitedStorage(),
    requestPersistence(),
  ])

  return { unlimited, persisted, evictionSafe: unlimited || persisted }
}
