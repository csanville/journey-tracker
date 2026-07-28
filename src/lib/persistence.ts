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
 *
 * The two calls do not live in the same place, which is the subtlety this
 * module exists to contain. In the Storage standard `persisted()` is exposed to
 * workers but `persist()` is `[Exposed=Window]`, so the service worker can only
 * ever *read* the state — asking for it has to come from the side panel.
 * Reading and requesting are therefore separate functions rather than one
 * "assess" call that silently does nothing in half its callers.
 */

import { patchSettings } from './settings'

export interface StorageProtection {
  /** `unlimitedStorage` granted — exempt from quota *and* eviction. */
  unlimited: boolean
  /** Whether the origin is marked persistent. */
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

function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.storage as StorageManager | undefined
}

/** Read-only, and exposed to workers. A missing API reads as "not persisted". */
async function isPersisted(): Promise<boolean> {
  const storage = storageManager()
  if (!storage?.persisted) return false

  try {
    return await storage.persisted()
  } catch {
    return false
  }
}

/**
 * Reports how well protected stored records are, without trying to change it.
 *
 * Safe to call from any context, including the service worker — it touches only
 * `persisted()`, never `persist()`.
 */
export async function readStorageProtection(): Promise<StorageProtection> {
  const [unlimited, persisted] = await Promise.all([hasUnlimitedStorage(), isPersisted()])

  return { unlimited, persisted, evictionSafe: unlimited || persisted }
}

/**
 * Asks Chrome to mark this origin's storage persistent, and reports the result.
 *
 * Window contexts only — `persist()` does not exist on a worker's
 * `StorageManager`, so calling this from the service worker degrades to a plain
 * read rather than pretending to have asked.
 *
 * A `false` here is a real answer rather than a pending one: Chrome decides on
 * engagement heuristics instead of prompting, so callers should report the
 * result rather than retry in a loop.
 */
export async function requestPersistence(): Promise<boolean> {
  const storage = storageManager()
  if (!storage?.persist) return isPersisted()

  try {
    if (await isPersisted()) return true
    return await storage.persist()
  } catch {
    return false
  }
}

/**
 * Reads protection and records it where the UI can warn about it (decision 3).
 *
 * Records are useless if the browser evicts them, and there is no telemetry
 * that would ever reveal the loss — so the answer is stored rather than merely
 * logged. Writing goes through the worker's settings, keeping the single-writer
 * rule intact (decision 4).
 */
export async function recordStorageProtection(): Promise<StorageProtection> {
  const protection = await readStorageProtection()

  await patchSettings({
    storagePersisted: protection.persisted,
    storageUnlimited: protection.unlimited,
  })

  if (!protection.evictionSafe) {
    console.warn(
      '[JourneyTracker] storage is neither unlimited nor persisted — records are evictable',
    )
  }

  return protection
}
