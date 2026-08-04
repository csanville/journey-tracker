/**
 * The panel's half of export and import: batching, files, and progress.
 *
 * Nothing here touches the database. Records are read and written through the
 * worker like every other mutation (decision 4), and this walks the traffic in
 * slices rather than asking for a `full` export in one message — see
 * `backup/import-postings` in `messages.ts` for why the batching is not
 * optional.
 *
 * The file half is small on purpose. A blob plus an `<a download>` click is a
 * real download with no permission at all; `chrome.downloads` would do the same
 * job and add a "manage your downloads" line to the install dialog, which is
 * exactly the trade decision 2 says not to make.
 */
import { send } from '../lib/client'
import {
  buildBundle,
  parseBundle,
  type Bundle,
  type BundleVariant,
  type Rejection,
} from '../lib/backup/bundle'
import { toCsv } from '../lib/backup/csv'
import type { ImportBatchResult } from '../lib/messages'
import type { Posting, Snapshot } from '../lib/types'

/**
 * How much goes in one message.
 *
 * Records are around a kilobyte, so two hundred of them is a payload the size
 * of a small image. Snapshots are up to 256KB each, so four is the same
 * ballpark — the batches are sized to be comparable in bytes rather than in
 * rows, because bytes are what the message port copies.
 */
const POSTING_BATCH = 200
const SNAPSHOT_BATCH = 4

export interface Progress {
  /** Units finished and expected — records for lean, records and pages for full. */
  done: number
  total: number
  /** What is happening, for a person watching a bar move. */
  what: string
}

export type OnProgress = (progress: Progress) => void

const noop: OnProgress = () => {}

/**
 * Assembles the bundle, reading snapshots in batches for a `full` export.
 *
 * The snapshot ids are fetched first rather than asking for a snapshot per
 * posting: only the most recent few hundred records have one (decision 6's
 * retention cap), so asking about all of them would be mostly round trips that
 * return nothing.
 */
export async function buildExport(
  variant: BundleVariant,
  onProgress: OnProgress = noop,
  at: number = Date.now(),
): Promise<Bundle> {
  const postings = await send('posting/list', {})

  if (variant === 'lean') {
    onProgress({ done: postings.length, total: postings.length, what: 'records' })
    return buildBundle('lean', postings, [], at)
  }

  const ids = await send('snapshot/ids', {})
  const total = postings.length + ids.length
  onProgress({ done: postings.length, total, what: 'records' })

  const snapshots: Snapshot[] = []

  for (const batch of chunk(ids, SNAPSHOT_BATCH)) {
    snapshots.push(...(await send('snapshot/list', { postingIds: batch })))
    onProgress({
      done: postings.length + snapshots.length,
      total,
      what: 'pages',
    })
  }

  return buildBundle('full', postings, snapshots, at)
}

/**
 * Pretty-printed, because this file is the user's only backup.
 *
 * Indentation costs a few percent on a `full` export — the bulk is snapshot
 * HTML, which is one long JSON string whatever the layout — and buys a file
 * somebody can open, read, and diff against last month's. For a format that
 * exists so data can survive this extension, being inspectable without a tool
 * is worth more than the bytes.
 */
export function serializeBundle(bundle: Bundle): string {
  return JSON.stringify(bundle, null, 2)
}

export function buildCsv(postings: Posting[]): string {
  return toCsv(postings)
}

export interface ImportSummary {
  variant: BundleVariant
  /** When the file was written, so the user can tell which backup this was. */
  exportedAt: number
  postings: ImportBatchResult
  snapshots: ImportBatchResult
  /** Records the file offered that this build would not take, with reasons. */
  rejected: Rejection[]
}

export type ImportResult =
  { ok: true; summary: ImportSummary } | { ok: false; error: string }

/**
 * Reads a file back in, one batch at a time.
 *
 * The file is parsed and validated in full before anything is sent, so a file
 * that is not ours cannot half-import: the envelope check either passes for the
 * whole file or nothing is written. Individual bad records are a different
 * matter — they are reported and the rest goes in, because losing four hundred
 * good records to one bad row is not a restore.
 *
 * Snapshots go after records, which is what makes an orphan impossible: the
 * repository drops a snapshot whose posting is not present, and by this point
 * every posting the file carried has already been offered.
 */
export async function importBundle(
  text: string,
  onProgress: OnProgress = noop,
): Promise<ImportResult> {
  const parsed = parseBundle(text)
  if (!parsed.ok) return parsed

  const { bundle, rejected } = parsed.parsed
  const total = bundle.postings.length + bundle.snapshots.length
  const summary: ImportSummary = {
    variant: bundle.variant,
    exportedAt: bundle.exportedAt,
    postings: { imported: 0, skipped: 0 },
    snapshots: { imported: 0, skipped: 0 },
    rejected,
  }

  let done = 0

  for (const batch of chunk(bundle.postings, POSTING_BATCH)) {
    const result = await send('backup/import-postings', {
      postings: batch,
      schemaVersion: bundle.schemaVersion,
    })
    add(summary.postings, result)
    done += batch.length
    onProgress({ done, total, what: 'records' })
  }

  for (const batch of chunk(bundle.snapshots, SNAPSHOT_BATCH)) {
    const result = await send('backup/import-snapshots', { snapshots: batch })
    add(summary.snapshots, result)
    done += batch.length
    onProgress({ done, total, what: 'pages' })
  }

  return { ok: true, summary }
}

function add(into: ImportBatchResult, result: ImportBatchResult): void {
  into.imported += result.imported
  into.skipped += result.skipped
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []

  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }

  return batches
}

/**
 * `journeytracker-2026-08-03-full.json`.
 *
 * Dated rather than versioned, because the question a person asks of a folder
 * of these is "how old is this one". The variant is in the name because a lean
 * and a full export of the same day are genuinely different files and one of
 * them is safe to share.
 */
export function backupFilename(variant: BundleVariant, at: number = Date.now()): string {
  return `journeytracker-${isoDay(at)}-${variant}.json`
}

export function csvFilename(at: number = Date.now()): string {
  return `journeytracker-${isoDay(at)}.csv`
}

function isoDay(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Hands the user a file, and answers how big it turned out to be.
 *
 * The size comes from the blob rather than from `contents.length`, which counts
 * UTF-16 units and would under-report every export containing an accented
 * company name or an en dash in a salary range — which is most of them.
 *
 * The object URL is revoked on a timer rather than immediately: revoking in the
 * same turn as the click races Chrome's read of it, and the failure is a
 * download that silently does not happen. A minute is far longer than needed
 * and costs one blob held in memory that was about to be written to disk
 * anyway.
 */
export function download(filename: string, contents: string, mime: string): number {
  const blob = new Blob([contents], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), 60_000)

  return blob.size
}

export const JSON_MIME = 'application/json'
/** `charset=utf-8` matters here: the file opens with a BOM and says so. */
export const CSV_MIME = 'text/csv;charset=utf-8'
