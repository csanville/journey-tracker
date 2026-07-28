/**
 * Settings live in `chrome.storage.local`, which holds settings and nothing
 * else — records are in IndexedDB (decision 3).
 *
 * That split matters most for `migrationInProgress`: the flag has to live
 * somewhere the migration is not itself rewriting, or a reader could not trust
 * what it read (decision 9).
 */

export interface Settings {
  /** Highest migration applied so far. 0 means "never migrated". */
  dataVersion: number
  /** Set while a migration runs; readers wait rather than query through it. */
  migrationInProgress: boolean
  /**
   * Result of `navigator.storage.persist()`. `null` means not yet asked.
   * `false` means records sit in evictable storage and the user needs telling.
   */
  storagePersisted: boolean | null
  lastBackupAt: number | null
}

export const SETTINGS_KEY = 'jt:settings'

export const DEFAULT_SETTINGS: Settings = {
  dataVersion: 0,
  migrationInProgress: false,
  storagePersisted: null,
  lastBackupAt: null,
}

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY)
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined
  return { ...DEFAULT_SETTINGS, ...value }
}

/**
 * Read-modify-write. Safe because the service worker is the only writer
 * (decision 4); if that ever stops being true this needs a real lock.
 */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

/**
 * Blocks until no migration is running.
 *
 * Readers call this instead of querying immediately, because an MV3 worker can
 * be torn down partway through a migration and a panel opening in that window
 * would otherwise read half-migrated data.
 */
export async function waitForMigration(timeoutMs = 30_000): Promise<void> {
  if (!(await readSettings()).migrationInProgress) return

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      chrome.storage.onChanged.removeListener(listener)
      if (error) reject(error)
      else resolve()
    }

    const timer = setTimeout(
      () => finish(new Error('timed out waiting for a migration to finish')),
      timeoutMs,
    )

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return
      const change = changes[SETTINGS_KEY]
      if (!change) return
      const next = change.newValue as Settings | undefined
      if (next && !next.migrationInProgress) finish()
    }

    chrome.storage.onChanged.addListener(listener)
  })
}
