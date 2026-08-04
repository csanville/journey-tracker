import type { JourneyTrackerDb } from './db'
import { deriveJoinKeys } from './normalize'
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
 * Version 1 stored `companyNormalized` and `canonicalUrl` exactly as the caller
 * supplied them — the fields existed, but nothing derived them. Version 2 makes
 * them real join keys computed by the repository.
 *
 * That is a change of *meaning* in a persisted field rather than a change of
 * shape, which is the kind that ships silently: nothing fails, and a record
 * written by the older build simply never matches a newer one on either dedupe
 * key. Decision 9 exists for exactly this, and a backfill is cheap now and
 * impossible once the records are on someone else's machine.
 *
 * Re-derivation is idempotent, so a worker killed partway through re-runs
 * harmlessly. `updatedAt` is deliberately untouched: this corrects a key, it is
 * not an edit the user made, and bumping it would reorder their list.
 */
const backfillJoinKeys: Migration = {
  to: 2,
  description: 'derive company, URL and requisition join keys on existing records',
  async run(db) {
    await db.transaction('rw', db.postings, async () => {
      const stored = await db.postings.toArray()

      const rewritten = stored.map((posting) => ({
        ...posting,
        ...deriveJoinKeys(posting),
        schemaVersion: 2,
      }))

      if (rewritten.length > 0) await db.postings.bulkPut(rewritten)
    })
  },
}

export const MIGRATIONS: Migration[] = [backfillJoinKeys]

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
  const { dataVersion, migrationInProgress } = await readSettings()

  // A flag still raised on entry is stale: the `finally` below clears it on
  // every path a running migration can take, and an MV3 worker terminated
  // mid-migration never gets to run it. Nothing else would ever clear it, so a
  // single killed migration would otherwise leave every future reader that
  // waits on the flag blocking until it times out — permanently.
  //
  // Clearing it *here* would be worse than leaving it. `waitForMigration`
  // resolves on the change event, so a reader parked on a stale flag would be
  // released moments before the migration below raises it again and starts
  // rewriting records — which is the half-migrated read the flag exists to
  // prevent. So the recovery happens only on the paths that do no work; the
  // paths that do work re-raise the flag and clear it honestly in `finally`.
  const staleFlag = migrationInProgress
  if (staleFlag) {
    console.warn('[JourneyTracker] found a migration flag left by an interrupted run')
  }

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
    await patchSettings({ dataVersion: targetVersion, migrationInProgress: false })
    return { from: 0, to: targetVersion, applied: [], freshInstall: true }
  }

  const pending = migrations
    .filter((m) => m.to > dataVersion && m.to <= targetVersion)
    .sort((a, b) => a.to - b.to)

  if (pending.length === 0) {
    // Nothing to do, so this is the safe place to retire a stale flag: no
    // migration follows to invalidate the readers it releases.
    if (dataVersion !== targetVersion || staleFlag) {
      await patchSettings({ dataVersion: targetVersion, migrationInProgress: false })
    }
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

/**
 * Brings records that arrived from an older export up to the current schema.
 *
 * A backup restored after an upgrade is the ordinary case for this: the file
 * was written by whatever build the user had, and the records inside it have
 * missed every migration since. Nothing else would ever apply them — the
 * harness above keys off `dataVersion`, which the worker brought up to date at
 * startup, so from its point of view there is nothing pending. This is the same
 * silent-loss shape decision 9 exists for, arriving through the one door that
 * does not go past the version stamp.
 *
 * It runs each migration across the **whole table**, not just the imported
 * rows, because a `Migration` is defined over the database and narrowing it to
 * a subset would be a second implementation of every migration ever written.
 * Safe because they are all required to be idempotent, and cheap because it
 * only runs at all when a file turns out to be behind — which today it never
 * is, since the exporter always writes at the current version.
 *
 * `dataVersion` is deliberately not touched. It records what this *database*
 * has been through, and it is already current; the imported records were the
 * only things behind.
 */
export async function migrateImportedRecords(
  db: JourneyTrackerDb,
  fromVersion: number,
  options: MigrationOptions = {},
): Promise<number[]> {
  const { migrations = MIGRATIONS, targetVersion = SCHEMA_VERSION } = options

  const pending = migrations
    .filter((m) => m.to > fromVersion && m.to <= targetVersion)
    .sort((a, b) => a.to - b.to)

  if (pending.length === 0) return []

  // Same guard as a startup migration: a panel reading through a half-rewritten
  // table gets the same wrong answer whichever door the rewrite came in by.
  await patchSettings({ migrationInProgress: true })
  try {
    for (const migration of pending) await migration.run(db)
  } finally {
    await patchSettings({ migrationInProgress: false })
  }

  return pending.map((migration) => migration.to)
}
