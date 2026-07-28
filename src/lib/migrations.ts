import type { JourneyTrackerDb } from './db'
import { patchSettings, readSettings } from './settings'
import { SCHEMA_VERSION } from './types'

/**
 * Data migrations — rewriting record contents, as opposed to the structural
 * upgrades Dexie handles in `db.ts`.
 *
 * Extensions update silently in the background, so there is no moment at which
 * the user can be asked to back up or intervene. A missing migration is silent
 * data loss on someone else's machine with no telemetry to catch it, so no
 * schema version ships without one (decision 9).
 *
 * Every migration must be forward-only and idempotent: an MV3 worker can be
 * killed partway through, and the survivor re-runs from the last completed
 * version.
 */
export interface Migration {
  /** The `dataVersion` this migration brings the database up to. */
  to: number
  description: string
  run(db: JourneyTrackerDb): Promise<void>
}

/**
 * Empty at schema version 1: there is no prior version in the wild to migrate
 * from. The harness is here now because retrofitting one after records exist on
 * users' machines is the problem it is meant to prevent.
 */
export const MIGRATIONS: Migration[] = []

export interface MigrationOutcome {
  from: number
  to: number
  /** Versions actually applied, in order. Empty on a fresh install. */
  applied: number[]
  /** True when the database was empty and was simply stamped as current. */
  freshInstall: boolean
}

export interface MigrationOptions {
  migrations?: Migration[]
  /**
   * Defaults to `SCHEMA_VERSION`. Injectable so the harness can be tested at a
   * hypothetical future version — otherwise there is no way to exercise it
   * until the first real migration exists, which is exactly when a broken
   * harness would do its damage.
   */
  targetVersion?: number
}

/**
 * Brings the database up to `SCHEMA_VERSION`, guarding readers while it works.
 *
 * Safe to call on every worker start, not just `onInstalled` — it is a no-op
 * once `dataVersion` is current, and relying on `onInstalled` alone would leave
 * a restarted worker serving requests against an unmigrated database.
 */
export async function runPendingMigrations(
  db: JourneyTrackerDb,
  options: MigrationOptions = {},
): Promise<MigrationOutcome> {
  const { migrations = MIGRATIONS, targetVersion = SCHEMA_VERSION } = options
  const { dataVersion } = await readSettings()

  // Data written by a newer build than this one. Refuse rather than carry on:
  // the version stamp is the only record of what has actually been applied, and
  // the paths below would overwrite it with a lower number while leaving the
  // records in their newer shape. Everything after that is silent corruption —
  // the old build writes its own `schemaVersion` over newer records, and
  // returning to the newer build replays migrations across a mix of both.
  //
  // Not hypothetical: `Load unpacked` is the whole development workflow here,
  // so loading a previous build is an ordinary thing to do.
  if (dataVersion > targetVersion) {
    throw new Error(
      `stored data is at version ${dataVersion} but this build only understands ` +
        `${targetVersion}. Refusing to open it — load the newer build instead.`,
    )
  }

  // A zero version with an empty database is a fresh install: stamp it as
  // current rather than replaying history against nothing. A zero version with
  // records means the settings were lost, and replaying is the safe answer —
  // which is exactly why migrations have to be idempotent.
  if (dataVersion === 0 && (await db.postings.count()) === 0) {
    await patchSettings({ dataVersion: targetVersion })
    return { from: 0, to: targetVersion, applied: [], freshInstall: true }
  }

  const pending = migrations
    .filter((m) => m.to > dataVersion && m.to <= targetVersion)
    .sort((a, b) => a.to - b.to)

  if (pending.length === 0) {
    if (dataVersion !== targetVersion) await patchSettings({ dataVersion: targetVersion })
    return { from: dataVersion, to: targetVersion, applied: [], freshInstall: false }
  }

  const applied: number[] = []
  await patchSettings({ migrationInProgress: true })
  try {
    for (const migration of pending) {
      await migration.run(db)
      // Recorded one at a time so a worker killed mid-run resumes from the last
      // completed migration rather than replaying the whole chain.
      await patchSettings({ dataVersion: migration.to })
      applied.push(migration.to)
    }
  } finally {
    // Cleared even on failure. A stuck flag would block every reader forever,
    // which is worse than letting them see an unmigrated database.
    await patchSettings({ migrationInProgress: false })
  }

  return { from: dataVersion, to: targetVersion, applied, freshInstall: false }
}
