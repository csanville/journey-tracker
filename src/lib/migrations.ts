import type { JourneyTrackerDb } from './db'
import { deriveJoinKeys, resolveProgress } from './normalize'
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

/**
 * Version 3 adds `stage` and `outcome` — what happened *after* an application,
 * as opposed to `state`, which is what the user did (decision 8).
 *
 * Adding a field that is allowed to be null looks like it needs no migration,
 * and that is the trap. A record written at version 2 reads back with these
 * properties **absent**, and `undefined` is not `null` anywhere it matters: the
 * CSV writer would print the string `undefined`, the export validator would see
 * a shape it does not recognise, and `resolveProgress` would carry the absence
 * straight back into storage. Backfilling makes the whole table one shape, which
 * is the only state the readers are written against.
 *
 * `resolveProgress` is reused rather than hardcoding two nulls, so the rule
 * about what may accompany a non-`applied` record lives in exactly one place —
 * and so a record already carrying the fields, from a re-run or a future export,
 * is corrected rather than trusted. `updatedAt` is untouched for the same reason
 * as version 2: this is not an edit the user made, and bumping it would reorder
 * their list.
 */
const backfillOutcomes: Migration = {
  to: 3,
  description: 'add stage and outcome to existing records',
  async run(db) {
    await db.transaction('rw', db.postings, async () => {
      const stored = await db.postings.toArray()

      const rewritten = stored.map((posting) => ({
        ...posting,
        ...resolveProgress({
          state: posting.state,
          stage: posting.stage ?? null,
          outcome: posting.outcome ?? null,
        }),
        schemaVersion: 3,
      }))

      if (rewritten.length > 0) await db.postings.bulkPut(rewritten)
    })
  },
}

export const MIGRATIONS: Migration[] = [backfillJoinKeys, backfillOutcomes]

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
  // Clearing it *here* would be worse than leaving it: the flag would drop for
  // the moment between that clear and the migration below raising it again to
  // start rewriting records, and a reader that looked in that window would see
  // `false` over half-migrated data — the exact read the flag exists to
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

  if (pending.length === 0) {
    // Nothing owed, so nothing should be left recorded as owed.
    await patchSettings({ importedBelowVersion: null })
    return []
  }

  // Same guard as a startup migration: a panel reading through a half-rewritten
  // table gets the same wrong answer whichever door the rewrite came in by.
  await patchSettings({ migrationInProgress: true })
  const applied: number[] = []

  try {
    for (const migration of pending) {
      await migration.run(db)
      // Recorded one at a time, exactly as `runPendingMigrations` records
      // `dataVersion`, and for exactly the same reason: an MV3 worker can be
      // killed between two steps of the chain. Without this the survivor has no
      // idea how far the chain got — and it cannot ask `dataVersion`, which was
      // already current before the import began — so the records would sit at an
      // intermediate version permanently, with nothing that would ever finish
      // them. That is the silent loss decision 9 exists to prevent, and this
      // function is the one place it could arrive from.
      await patchSettings({ importedBelowVersion: migration.to })
      applied.push(migration.to)
    }

    await patchSettings({ importedBelowVersion: null })
  } finally {
    await patchSettings({ migrationInProgress: false })
  }

  return applied
}

/**
 * Records that records below the current schema version have been imported.
 *
 * Written before the migration rather than after it, so a worker torn down
 * between the write and the rewrite still knows there is a debt. Takes the
 * lowest version seen, since a file may carry records from more than one era.
 */
export async function noteImportedVersion(version: number): Promise<void> {
  const { importedBelowVersion } = await readSettings()

  if (importedBelowVersion !== null && importedBelowVersion <= version) return

  await patchSettings({ importedBelowVersion: version })
}

/**
 * Finishes any import migration that was recorded and not completed.
 *
 * Called at the end of an import, and again at every worker start — the second
 * is what makes a panel that closed mid-import, or a batch that failed, a delay
 * rather than a permanent loss. A no-op when nothing is owed, which is every
 * ordinary start.
 */
export async function resumeImportMigration(
  db: JourneyTrackerDb,
  options: MigrationOptions = {},
): Promise<number[]> {
  const { importedBelowVersion } = await readSettings()
  if (importedBelowVersion === null) return []

  return migrateImportedRecords(db, importedBelowVersion, options)
}
