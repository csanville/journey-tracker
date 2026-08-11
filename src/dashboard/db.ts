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
 * Opens the database for reading, once the worker has brought it up to date.
 *
 * The `status` round-trip is not a probe for its own sake, and — since the fix
 * described below — it is not conditional either. Every request is dispatched
 * through `await ready()` in the service worker, so asking *anything* is what
 * causes the worker to open the store, run pending migrations, and only then
 * answer. One message buys both of the things this connection cannot do for
 * itself.
 *
 * **Creating.** Dynamic mode cannot create a database — that is the point of
 * using it — so the first-ever dashboard open has to go through the single
 * writer. This half was always here.
 *
 * **Migrating.** This half was not, and it cost phase 8 its worst defect. The
 * round-trip used to happen only after Dexie reported the database missing, so
 * on every ordinary open — the database exists, which is all of them after the
 * first — the dashboard read rows that nothing had migrated in this context.
 * A record written at version 2 arrives with `outcome` *absent*, `undefined` is
 * not `null`, and the outcomes card rendered "Of 2 applications: 0 still open"
 * over two open applications. Decision 9 says the dashboard waits on the
 * migration flag; it never did, and the helper written to do the waiting never
 * had a caller. Phase 11 deleted that helper on the strength of the paragraph
 * below.
 *
 * Gating the open is stronger than waiting on the flag, which is why it is done
 * this way round: the flag can only be *observed*, so a reader watching it
 * cannot make a torn-down worker migrate — it would see `false` and read the
 * stale data with confidence. Asking the worker is what causes the work.
 *
 * The cost is deliberate: an unreachable worker now fails the open instead of
 * serving whatever is on disk. That is the right trade for this project. The
 * rows are readable but their *shape* is unknown, and `usePostings` renders a
 * failure as itself while it would render unmigrated data as fact — which is
 * this file's oldest recurring defect, not a graceful degradation.
 */
export async function openForReading(name: string = DB_NAME): Promise<Dexie> {
  // If this throws, the worker is unreachable. That is a different failure from
  // "no data" and worth surfacing as itself — see `usePostings`.
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
