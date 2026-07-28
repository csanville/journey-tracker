import { describe, expect, it } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import { runPendingMigrations, type Migration } from './migrations'
import { upsertPosting } from './repository'
import { patchSettings, readSettings, waitForMigration } from './settings'
import { SCHEMA_VERSION } from './types'

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
      runPendingMigrations(db, { targetVersion: 3, migrations: [migration(2, ran), flaky] }),
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
          { to: 2, description: 'explodes', run: async () => { throw new Error('boom') } },
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
