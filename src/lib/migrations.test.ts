import { describe, expect, it } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import {
  migrateImportedRecords,
  noteImportedVersion,
  resumeImportMigration,
  runPendingMigrations,
  type Migration,
} from './migrations'
import { upsertPosting } from './repository'
import { patchSettings, readSettings, waitForMigration } from './settings'
import { SCHEMA_VERSION } from './types'
import type { Posting } from './types'

describe('runPendingMigrations', () => {
  it('stamps a fresh install as current without replaying history', async () => {
    const db = await freshDb()

    const outcome = await runPendingMigrations(db)

    expect(outcome.freshInstall).toBe(true)
    expect(outcome.applied).toEqual([])
    expect((await readSettings()).dataVersion).toBe(SCHEMA_VERSION)
  })

  it('replays migrations when settings were lost but records survive', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    // dataVersion is 0 while the database plainly has data — the settings were
    // cleared. Replaying is the safe answer, and is only safe because
    // migrations are idempotent.
    const ran: number[] = []

    const outcome = await runPendingMigrations(db, {
      targetVersion: 1,
      migrations: [migration(1, ran)],
    })

    expect(outcome.freshInstall).toBe(false)
    expect(outcome.applied).toEqual([1])
    expect(ran).toEqual([1])
  })

  it('migrates a seeded prior version forward, in order', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 1 })
    const ran: number[] = []

    const outcome = await runPendingMigrations(db, {
      targetVersion: 3,
      migrations: [migration(3, ran), migration(2, ran)],
    })

    expect(outcome.from).toBe(1)
    expect(outcome.to).toBe(3)
    // Declared out of order on purpose: the runner sorts, callers should not
    // have to.
    expect(ran).toEqual([2, 3])
    expect((await readSettings()).dataVersion).toBe(3)
  })

  it('is a no-op once the data version is current', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 2 })
    const ran: number[] = []

    await runPendingMigrations(db, {
      targetVersion: 2,
      migrations: [migration(2, ran)],
    })

    expect(ran).toEqual([])
  })

  it('backfills join keys onto records written before they were derived', async () => {
    const db = await freshDb()
    // A version 1 record: the key fields exist but hold whatever the caller
    // sent, because nothing derived them yet. Written straight to the store,
    // since `upsertPosting` would normalize it on the way in.
    await db.postings.put({
      ...aPosting({
        id: 'legacy',
        company: 'Acme, Inc.',
        url: 'https://www.boards.greenhouse.io/acme/jobs/4012345?utm_source=email',
        atsReqId: null,
      }),
      companyNormalized: 'Acme, Inc.',
      canonicalUrl: 'https://www.boards.greenhouse.io/acme/jobs/4012345?utm_source=email',
      schemaVersion: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await patchSettings({ dataVersion: 1 })

    await runPendingMigrations(db)

    const migrated = await db.postings.get('legacy')
    expect(migrated?.companyNormalized).toBe('acme')
    expect(migrated?.canonicalUrl).toBe('https://boards.greenhouse.io/acme/jobs/4012345')
    expect(migrated?.atsReqId).toBe('4012345')
    expect(migrated?.schemaVersion).toBe(2)
    // A key correction is not an edit the user made; bumping this would
    // reorder their list.
    expect(migrated?.updatedAt).toBe(1_000)
  })

  it('leaves an already-derived record byte-identical when replayed', async () => {
    const db = await freshDb()
    const stored = await upsertPosting(db, aPosting({ id: 'current' }))
    await patchSettings({ dataVersion: 1 })

    // A worker killed mid-migration re-runs the whole thing on the survivors.
    await runPendingMigrations(db)

    expect(await db.postings.get('current')).toEqual({ ...stored, schemaVersion: 2 })
  })

  it('clears a migration flag left behind by a killed worker', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    // What a worker terminated mid-migration leaves behind: the flag is raised
    // and no `finally` ever ran. Nothing else clears it, so every reader that
    // waits on it would block until timeout, forever.
    await patchSettings({ dataVersion: SCHEMA_VERSION, migrationInProgress: true })

    await runPendingMigrations(db)

    expect((await readSettings()).migrationInProgress).toBe(false)
    await expect(waitForMigration(50)).resolves.toBeUndefined()
  })

  it('does not release a waiting reader before the real migration finishes', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    // A stale flag *and* work to do: the interrupted run left the flag up, and
    // this run is about to redo it.
    await patchSettings({ dataVersion: 1, migrationInProgress: true })

    let released = false
    let releasedDuringRun: boolean | undefined
    const waiting = waitForMigration(1_000).then(() => {
      released = true
    })

    await runPendingMigrations(db, {
      targetVersion: 2,
      migrations: [
        {
          to: 2,
          description: 'observes whether readers were let go early',
          async run() {
            // Let any pending change notifications settle first.
            await Promise.resolve()
            releasedDuringRun = released
          },
        },
      ],
    })
    await waiting

    // Clearing the stale flag on entry would resolve the waiter here, moments
    // before this same call raises the flag again and starts rewriting records
    // — the half-migrated read the flag exists to prevent.
    expect(releasedDuringRun).toBe(false)
    expect(released).toBe(true)
  })

  it('refuses to open data written by a newer build', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 3 })

    await expect(
      runPendingMigrations(db, { targetVersion: 1, migrations: [] }),
    ).rejects.toThrow(/version 3 .* only understands 1/)
  })

  it('leaves the version stamp alone when it refuses a downgrade', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 3 })

    await expect(
      runPendingMigrations(db, { targetVersion: 1, migrations: [] }),
    ).rejects.toThrow()

    // Stamping this down to 1 would destroy the only record of what has
    // actually been applied, and the records would still be in v3 shape.
    expect((await readSettings()).dataVersion).toBe(3)
  })

  it('resumes from the last completed migration after a worker dies mid-run', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 1 })
    const ran: number[] = []

    let shouldFail = true
    const flaky: Migration = {
      to: 3,
      description: 'fails once, as a torn-down worker would',
      async run() {
        if (shouldFail) {
          shouldFail = false
          throw new Error('worker terminated')
        }
        ran.push(3)
      },
    }

    await expect(
      runPendingMigrations(db, {
        targetVersion: 3,
        migrations: [migration(2, ran), flaky],
      }),
    ).rejects.toThrow('worker terminated')

    // Version 2 completed and was recorded, so the retry must not replay it.
    expect(ran).toEqual([2])
    expect((await readSettings()).dataVersion).toBe(2)

    await runPendingMigrations(db, {
      targetVersion: 3,
      migrations: [migration(2, ran), flaky],
    })

    expect(ran).toEqual([2, 3])
    expect((await readSettings()).dataVersion).toBe(3)
  })

  it('clears the in-progress flag even when a migration throws', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 1 })

    await expect(
      runPendingMigrations(db, {
        targetVersion: 2,
        migrations: [
          {
            to: 2,
            description: 'explodes',
            run: async () => {
              throw new Error('boom')
            },
          },
        ],
      }),
    ).rejects.toThrow('boom')

    // A stuck flag would block every reader forever, which is worse than
    // letting them see an unmigrated database.
    expect((await readSettings()).migrationInProgress).toBe(false)
  })

  it('holds the in-progress flag up while a migration is running', async () => {
    const db = await freshDb()
    await upsertPosting(db, aPosting())
    await patchSettings({ dataVersion: 1 })
    let seenDuringRun: boolean | undefined

    await runPendingMigrations(db, {
      targetVersion: 2,
      migrations: [
        {
          to: 2,
          description: 'observes the guard from inside',
          async run() {
            seenDuringRun = (await readSettings()).migrationInProgress
          },
        },
      ],
    })

    expect(seenDuringRun).toBe(true)
    expect((await readSettings()).migrationInProgress).toBe(false)
  })
})

describe('waitForMigration', () => {
  it('returns immediately when nothing is running', async () => {
    await expect(waitForMigration(50)).resolves.toBeUndefined()
  })

  it('blocks a reader until the migration clears the flag', async () => {
    await patchSettings({ migrationInProgress: true })
    let resolved = false

    const waiting = waitForMigration(1_000).then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    await patchSettings({ migrationInProgress: false })
    await waiting
    expect(resolved).toBe(true)
  })

  it('gives up rather than hanging forever on a stuck flag', async () => {
    await patchSettings({ migrationInProgress: true })
    await expect(waitForMigration(20)).rejects.toThrow(/timed out/)
  })
})

/** A migration that records the fact it ran, so ordering can be asserted. */
function migration(to: number, log: number[]): Migration {
  return {
    to,
    description: `test migration to ${to}`,
    run: async () => {
      log.push(to)
    },
  }
}

/**
 * The one door into the database that does not go past the version stamp.
 *
 * A backup restored after an upgrade carries records written by the build the
 * user had, and the harness above would never touch them — from its point of
 * view `dataVersion` is already current and nothing is pending. That is the
 * silent-loss shape decision 9 exists for.
 */
describe('migrateImportedRecords', () => {
  it('does nothing when the file was already current', async () => {
    const db = await freshDb()
    const ran: number[] = []

    const applied = await migrateImportedRecords(db, 2, {
      targetVersion: 2,
      migrations: [migration(1, ran), migration(2, ran)],
    })

    expect(applied).toEqual([])
    expect(ran).toEqual([])
  })

  it('applies every migration between the file’s version and this build’s', async () => {
    const db = await freshDb()
    const ran: number[] = []

    const applied = await migrateImportedRecords(db, 1, {
      targetVersion: 3,
      migrations: [migration(3, ran), migration(1, ran), migration(2, ran)],
    })

    expect(applied).toEqual([2, 3])
    expect(ran).toEqual([2, 3])
  })

  // A panel reading through a half-rewritten table gets the same wrong answer
  // whichever door the rewrite came in by.
  it('raises the migration flag while it works and clears it after', async () => {
    const db = await freshDb()
    let flagDuring: boolean | null = null

    await migrateImportedRecords(db, 1, {
      targetVersion: 2,
      migrations: [
        {
          to: 2,
          description: 'observes the flag',
          run: async () => {
            flagDuring = (await readSettings()).migrationInProgress
          },
        },
      ],
    })

    expect(flagDuring).toBe(true)
    expect((await readSettings()).migrationInProgress).toBe(false)
  })

  it('clears the flag even when a migration throws', async () => {
    const db = await freshDb()

    await expect(
      migrateImportedRecords(db, 1, {
        targetVersion: 2,
        migrations: [
          {
            to: 2,
            description: 'fails',
            run: async () => {
              throw new Error('no')
            },
          },
        ],
      }),
    ).rejects.toThrow('no')

    expect((await readSettings()).migrationInProgress).toBe(false)
  })

  /**
   * `dataVersion` records what this *database* has been through, and it is
   * already current — the imported records were the only things behind.
   */
  it('leaves the database’s own version stamp alone', async () => {
    const db = await freshDb()
    await patchSettings({ dataVersion: 5 })
    const ran: number[] = []

    await migrateImportedRecords(db, 1, {
      targetVersion: 2,
      migrations: [migration(2, ran)],
    })

    expect((await readSettings()).dataVersion).toBe(5)
  })

  it('backfills the join keys of a record that arrived from a v1 export', async () => {
    const db = await freshDb()
    // What a phase 1 build stored: the fields existed but held whatever the
    // caller sent.
    await db.postings.add({
      ...(aPosting({
        id: 'old',
        company: 'Initech Inc.',
        url: 'https://boards.greenhouse.io/initech/jobs/9?utm_source=x',
      }) as Posting),
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      companyNormalized: 'Initech Inc.',
      canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/9?utm_source=x',
    })

    await migrateImportedRecords(db, 1)

    const migrated = await db.postings.get('old')
    expect(migrated?.companyNormalized).toBe('initech')
    expect(migrated?.canonicalUrl).toBe('https://boards.greenhouse.io/initech/jobs/9')
    expect(migrated?.schemaVersion).toBe(2)
    // Correcting a key is not an edit the user made; bumping this would reorder
    // their list.
    expect(migrated?.updatedAt).toBe(1)
  })
})

/**
 * The durable half of importing a backup from an older build.
 *
 * `dataVersion` cannot carry this debt — it records what the *database* has
 * been through, and it is already current when an import begins — so without a
 * separate note, a chain interrupted between two steps leaves records at an
 * intermediate version with nothing that would ever finish them. That is
 * decision 9's silent loss arriving through the one door that skips the version
 * stamp.
 */
describe('resuming an import migration', () => {
  it('records progress after each step, not only at the end', async () => {
    const db = await freshDb()
    const seen: (number | null)[] = []

    await migrateImportedRecords(db, 0, {
      targetVersion: 3,
      migrations: [1, 2, 3].map((to) => ({
        to,
        description: `to ${to}`,
        run: async () => {
          seen.push((await readSettings()).importedBelowVersion)
        },
      })),
    })

    // Each migration sees the version the one before it completed at, which is
    // what a worker restarting mid-chain would read.
    expect(seen).toEqual([null, 1, 2])
    expect((await readSettings()).importedBelowVersion).toBeNull()
  })

  it('leaves the debt recorded when a step throws', async () => {
    const db = await freshDb()
    await noteImportedVersion(1)

    await expect(
      migrateImportedRecords(db, 1, {
        targetVersion: 3,
        migrations: [
          { to: 2, description: 'works', run: async () => {} },
          {
            to: 3,
            description: 'dies',
            run: async () => {
              throw new Error('worker torn down')
            },
          },
        ],
      }),
    ).rejects.toThrow('worker torn down')

    // Step 2 finished, step 3 did not — so the survivor picks up from 2 rather
    // than replaying from 1 or, worse, believing there is nothing left to do.
    expect((await readSettings()).importedBelowVersion).toBe(2)
    expect((await readSettings()).migrationInProgress).toBe(false)
  })

  it('finishes the chain on the next start', async () => {
    const db = await freshDb()
    await noteImportedVersion(2)
    const ran: number[] = []

    const applied = await resumeImportMigration(db, {
      targetVersion: 3,
      migrations: [migration(2, ran), migration(3, ran)],
    })

    expect(applied).toEqual([3])
    expect(ran).toEqual([3])
    expect((await readSettings()).importedBelowVersion).toBeNull()
  })

  it('does nothing when no debt was recorded, which is every ordinary start', async () => {
    const db = await freshDb()
    const ran: number[] = []

    expect(await resumeImportMigration(db, { migrations: [migration(2, ran)] })).toEqual([])
    expect(ran).toEqual([])
  })

  it('clears a debt that turns out to need no migration', async () => {
    const db = await freshDb()
    await noteImportedVersion(SCHEMA_VERSION)

    await resumeImportMigration(db)

    expect((await readSettings()).importedBelowVersion).toBeNull()
  })
})

describe('noteImportedVersion', () => {
  it('keeps the lowest version seen across batches', async () => {
    await noteImportedVersion(2)
    await noteImportedVersion(1)
    expect((await readSettings()).importedBelowVersion).toBe(1)

    // A later, higher batch must not raise the debt and strand the older
    // records a previous batch already brought in.
    await noteImportedVersion(2)
    expect((await readSettings()).importedBelowVersion).toBe(1)
  })
})
