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
   * Routinely `false` on a freshly installed extension — Chrome judges this on
   * engagement heuristics — which is why it is not the only defence.
   */
  storagePersisted: boolean | null
  /** Whether `unlimitedStorage` is granted, which alone exempts from eviction. */
  storageUnlimited: boolean | null
  lastBackupAt: number | null
  /**
   * The schema version of the oldest records an import has brought in and not
   * yet finished migrating, or `null` when there is no such debt.
   *
   * This is the durable half of importing a backup written by an older build.
   * `dataVersion` cannot carry it — that records what this *database* has been
   * through, and it is already current — so without somewhere to write the debt
   * down, an import interrupted between two migration steps would leave records
   * at an intermediate version with nothing that would ever finish them. The
   * worker checks this at every start and resumes (decision 9).
   */
  importedBelowVersion: number | null
}

export const SETTINGS_KEY = 'jt:settings'

export const DEFAULT_SETTINGS: Settings = {
  dataVersion: 0,
  migrationInProgress: false,
  storagePersisted: null,
  storageUnlimited: null,
  lastBackupAt: null,
  importedBelowVersion: null,
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
 * **Nothing in the extension calls this, and that is now deliberate.** It was
 * written for decision 9's "the panel and dashboard wait on that flag" and was
 * wired to neither for six phases, which is what let unmigrated records reach
 * the dashboard's aggregations in phase 8.
 *
 * Both readers are covered without it, and by something stronger. Every request
 * the panel sends and the `status` round-trip the dashboard now opens with are
 * dispatched through `await ready()` in the service worker, which runs pending
 * migrations *before* answering. The difference is cause versus observation: a
 * reader watching this flag cannot make a torn-down worker migrate, and would
 * see `false` and read stale data with confidence. Asking the worker is what
 * causes the work. See `dashboard/db.ts`.
 *
 * Kept because the flag it waits on is real and a diagnostics surface is the
 * obvious future caller — but it is a utility, not a protection anything
 * currently relies on, and a comment claiming otherwise is the exact defect
 * this project keeps counting.
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
