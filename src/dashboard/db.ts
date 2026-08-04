/**
 * The dashboard's read-only view of the database.
 *
 * Decision 4 forbids the dashboard *writing* to IndexedDB and expects it to read
 * directly, with `liveQuery` supplying reactivity instead of polling. Decision
 * 14's amendment then rejected a panel-side connection for phase 6's export,
 * with a reason that applies here just as well: whichever context declares the
 * schema is the one that performs Dexie's structural upgrade on the next release
 * that adds an index, and a dashboard open in three tabs would race the worker
 * for it.
 *
 * Both hold at once because this connection **declares no schema**. Constructing
 * a `Dexie` with no `version()` call opens it in dynamic mode: it reads whatever
 * stores and indexes are already on disk, and it has no version of its own to
 * upgrade *to*, so it cannot trigger one. The worker keeps `JourneyTrackerDb`
 * and stays the only context that can restructure anything. Verified in
 * `db.test.ts`, including against a database the worker has since upgraded.
 *
 * The cost is that `db.table('postings')` is untyped, so the cast at the boundary
 * below is the one place this file has to assert what the worker wrote.
 */

import Dexie from 'dexie'
import { DB_NAME } from '../lib/db'
import type { Posting } from '../lib/types'
import { send } from '../lib/client'

/**
 * Dexie's error when dynamic mode is pointed at a database that does not exist.
 *
 * Reachable in one real situation: the dashboard opened before anything has ever
 * been saved. Dynamic mode cannot create the database — that is the whole point
 * of using it — so the worker has to be asked to.
 */
const NO_SUCH_DATABASE = 'NoSuchDatabaseError'

/**
 * Opens the database for reading, asking the worker to create it if it is not
 * there yet.
 *
 * The `status` round-trip is not a probe for its own sake: every request is
 * dispatched through `await ready()` in the service worker, so asking anything
 * at all is what causes the worker to open — and therefore create — the store.
 * That keeps creation in the single writer even though the reader noticed the
 * absence.
 */
export async function openForReading(name: string = DB_NAME): Promise<Dexie> {
  try {
    return await openDynamic(name)
  } catch (error) {
    if ((error as { name?: string })?.name !== NO_SUCH_DATABASE) throw error
  }

  // Only reached on a database that has never existed. If this throws, the
  // worker is unreachable, which is a different failure and worth showing as
  // itself rather than as "no data".
  await send('status', {})
  return openDynamic(name)
}

async function openDynamic(name: string): Promise<Dexie> {
  const db = new Dexie(name)
  await db.open()
  return db
}

/**
 * Every posting, newest first.
 *
 * Sorted in memory rather than through the `updatedAt` index because dynamic
 * mode inherits whatever indexes exist on disk, and a build older than the one
 * that added an index would throw here rather than return unsorted rows. The
 * record count is bounded by what one person applies to, so the sort is free.
 */
export async function readPostings(db: Dexie): Promise<Posting[]> {
  const rows = (await db.table('postings').toArray()) as Posting[]
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * A `liveQuery` over every posting, as an unsubscribe-able subscription.
 *
 * Hand-rolled rather than `dexie-react-hooks`, which would be a dependency for
 * about fifteen lines and would fold "not loaded yet" and "loaded, and empty"
 * into the same `undefined`. Phase 6 spent a defect on precisely that confusion
 * — a dialog offering to erase zero records over a full database — and
 * `RecentPostings` already keeps the two apart deliberately.
 */
export function subscribeToPostings(
  db: Dexie,
  onValue: (postings: Posting[]) => void,
  onError: (error: unknown) => void,
): () => void {
  const subscription = Dexie.liveQuery(() => readPostings(db)).subscribe({
    next: onValue,
    error: onError,
  })

  return () => subscription.unsubscribe()
}
