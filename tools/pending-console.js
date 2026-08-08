/**
 * Driving the submission prompt without applying to anything.
 *
 * Paste this whole file into the DevTools console of an **extension page** —
 * the dashboard is the convenient one — and it defines a `jt` object. It will
 * not work from a job board's console: a content script runs in an isolated
 * world with no `chrome.storage` access, which is the same boundary decision 4
 * relies on.
 *
 * ## Read this first: most testing does not need this file
 *
 * Submission detection is a **URL match on page load**, not an observation of a
 * form being submitted. `confirmationTarget` matches
 *
 *     https://job-boards.greenhouse.io/<token>/jobs/<numeric id>/confirmation
 *
 * and the content script checks it on every load and every SPA navigation. So
 * the entire real path — content script, worker, `findDuplicate`, the store, the
 * panel — runs if you simply:
 *
 *   1. Save any Greenhouse posting in the panel. Do not apply to it.
 *   2. Navigate to that same URL with `/confirmation` on the end.
 *
 * That is the honest end-to-end test, it is repeatable, and it is undone by
 * deleting the record. Prefer it. Use this file only for the states it cannot
 * reach.
 *
 * ## What this file is for
 *
 * Three things the recipe above cannot produce:
 *
 * - **Dates in the past.** The recipe always stamps `confirmedAt` as now, so it
 *   cannot show that answering days later still records the confirmation date.
 * - **Expiry.** `PENDING_TTL_MS` is fourteen days. Waiting is not a test.
 * - **A queue in one step**, without navigating once per entry.
 *
 * ## What it deliberately cannot do
 *
 * It seeds the store; it does not fake a confirmation to the worker. Sending
 * `application/submitted` from here would be answered `{ matched: false }`
 * regardless, because the handler takes the tab from `sender.tab` and an
 * extension page has none — so a "simulated" submission would exercise a path
 * the real one never takes and prove nothing about it.
 */

globalThis.jt = (() => {
  const KEY = 'pendingSubmissions'
  const DAY = 24 * 60 * 60 * 1000

  /** Must match `PENDING_TTL_MS` in `src/lib/pending.ts`. */
  const TTL_DAYS = 14

  async function request(kind, payload = {}) {
    const response = await chrome.runtime.sendMessage({ kind, ...payload })
    if (!response) throw new Error('no response from the service worker')
    if (!response.ok) throw new Error(response.error)
    return response.data
  }

  const jt = {
    /** Every saved posting, newest first, as a console table. */
    async list() {
      const postings = await request('posting/list')
      console.table(
        postings.map((p) => ({
          id: p.id,
          company: p.company,
          title: p.jobTitle,
          state: p.state,
          applied: p.appliedAt ? new Date(p.appliedAt).toISOString().slice(0, 10) : '',
        })),
      )
      return postings
    },

    /** The queue as it stands, with each entry's age in days. */
    async pending() {
      const store = (await chrome.storage.local.get(KEY))[KEY] ?? {}
      const postings = await request('posting/list')
      const named = Object.fromEntries(postings.map((p) => [p.id, p]))

      console.table(
        Object.entries(store)
          .sort(([, a], [, b]) => a - b)
          .map(([id, confirmedAt]) => ({
            id,
            company: named[id]?.company ?? '(record is gone)',
            confirmedAt: new Date(confirmedAt).toISOString(),
            ageDays: +((Date.now() - confirmedAt) / DAY).toFixed(1),
            expired: Date.now() - confirmedAt >= TTL_DAYS * DAY,
          })),
      )
      return store
    },

    /**
     * Puts a question in the queue, `daysAgo` days old.
     *
     * Anything at or past `TTL_DAYS` is swept the moment the panel reads it,
     * which is the point when testing expiry — the prompt should never appear.
     */
    async add(postingId, daysAgo = 0) {
      const store = (await chrome.storage.local.get(KEY))[KEY] ?? {}
      store[postingId] = Date.now() - daysAgo * DAY
      await chrome.storage.local.set({ [KEY]: store })
      return jt.pending()
    },

    /**
     * A ready-made queue over the first `count` savable records.
     *
     * Ages them a day apart so the answering order is visible: oldest first, so
     * the *last* one seeded is the first one asked about.
     */
    async queue(count = 3) {
      const postings = await request('posting/list')
      const usable = postings.filter((p) => p.state !== 'applied').slice(0, count)

      if (usable.length < count) {
        console.warn(
          `only ${usable.length} record(s) are not already applied — ` +
            `save a few more postings, or use jt.unapply(id)`,
        )
      }

      const store = {}
      usable.forEach((posting, index) => {
        store[posting.id] = Date.now() - (usable.length - index) * DAY
      })

      await chrome.storage.local.set({ [KEY]: store })
      return jt.pending()
    },

    /**
     * Puts a record back to `viewed` so it can be asked about again.
     *
     * The prompt is only raised for a record that is not already `applied`, so
     * without this every run of a test consumes a record permanently. Sends the
     * whole posting back through `posting/upsert`, which is the only writer.
     *
     * Spreading the stored record rather than projecting through
     * `POSTING_INPUT_FIELDS` is safe here, and only here: `upsertPosting`
     * overwrites `schemaVersion` and `updatedAt` and keeps the existing
     * `createdAt`, so the three fields a caller has no business sending cannot
     * survive the round trip anyway.
     */
    async unapply(postingId) {
      const posting = await request('posting/get', { id: postingId })
      if (!posting) throw new Error(`no record ${postingId}`)

      await request('posting/upsert', {
        posting: { ...posting, state: 'viewed', appliedAt: null },
      })
      return jt.list()
    },

    /** Empties the queue. Does not touch any record. */
    async clear() {
      await chrome.storage.local.remove(KEY)
      console.log('pending queue cleared')
    },
  }

  console.log(
    'jt ready — jt.list(), jt.pending(), jt.queue(n), jt.add(id, daysAgo), ' +
      'jt.unapply(id), jt.clear()\n' +
      'Reopen the side panel after seeding: it reads the queue on mount.',
  )

  return jt
})()
