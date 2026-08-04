import { useState } from 'react'
import { send } from '../lib/client'
import type { BundleVariant } from '../lib/backup/bundle'
import type { StatusReport } from '../lib/messages'
import {
  CSV_MIME,
  JSON_MIME,
  backupFilename,
  buildCsv,
  buildExport,
  csvFilename,
  download,
  importBundle,
  serializeBundle,
  type ImportSummary,
  type Progress,
} from './backup'
import { formatWhen } from './RecentPostings'

/**
 * Export, import, and the one button that empties the database.
 *
 * These three belong together because they are one workflow, not three
 * features: the way a person finds out their backup is real is by wiping and
 * restoring it, and a wipe offered anywhere else would be a button with nothing
 * next to it but regret. Decision 1 puts the data on exactly one device, which
 * makes the export the whole of the backup story — so this is closer to the
 * point of the extension than its placement in a drawer suggests.
 *
 * Folded away all the same. It is a thing done occasionally and on purpose,
 * and the panel's job on an ordinary day is the form.
 */
type Busy = { progress: Progress | null; what: string }

type Outcome =
  { tone: 'good'; message: string; detail?: string } | { tone: 'bad'; message: string }

export function BackupSection({
  status,
  onChanged,
}: {
  status: StatusReport | null
  /** Records were written or erased; the panel's counts and list are stale. */
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<Busy | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [confirmingErase, setConfirmingErase] = useState(false)

  const postingCount = status?.postingCount ?? 0
  const snapshotCount = status?.snapshotCount ?? 0
  const nothingStored = status !== null && postingCount === 0

  /**
   * Every action funnels through here so that "something is running" is one
   * piece of state rather than one per button. Two exports at once would be
   * harmless; an import racing a wipe would not be, and the difference is not
   * worth encoding twice.
   */
  async function run(
    what: string,
    action: (report: (p: Progress) => void) => Promise<Outcome>,
  ) {
    if (busy) return

    setBusy({ progress: null, what })
    setOutcome(null)

    try {
      setOutcome(await action((progress) => setBusy({ progress, what })))
    } catch (error) {
      console.error('[JourneyTracker] backup action failed', what, error)
      setOutcome({
        tone: 'bad',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  const exportJson = (variant: BundleVariant) =>
    run(variant === 'full' ? 'Reading pages' : 'Reading records', async (report) => {
      const at = Date.now()
      const bundle = await buildExport(variant, report, at)
      const filename = backupFilename(variant, at)
      const size = download(filename, serializeBundle(bundle), JSON_MIME)

      // Only after the file has actually been handed over, and only for JSON —
      // a CSV cannot be imported, so letting one set this would be a "last
      // backed up" date behind which there is no backup.
      try {
        await send('backup/recorded', {})
        onChanged()
      } catch (error) {
        // The file is written; the bookkeeping is not worth failing over.
        console.error('[JourneyTracker] could not record the backup', error)
      }

      return {
        tone: 'good',
        message: `Exported ${count(bundle.postings.length, 'record')}${
          variant === 'full' ? ` and ${count(bundle.snapshots.length, 'page')}` : ''
        }.`,
        detail: `${filename} · ${bytes(size)}`,
      }
    })

  const exportCsv = () =>
    run('Reading records', async () => {
      const at = Date.now()
      const postings = await send('posting/list', {})
      const text = buildCsv(postings)

      download(csvFilename(at), text, CSV_MIME)

      return {
        tone: 'good',
        message: `Wrote a spreadsheet of ${count(postings.length, 'record')}.`,
        // Said plainly rather than left to be discovered when somebody tries.
        detail: `${csvFilename(at)} · a report, not a backup — it cannot be imported`,
      }
    })

  const importFile = (file: File) =>
    run('Importing', async (report) => {
      const result = await importBundle(await file.text(), report)

      if (!result.ok) {
        return { tone: 'bad', message: `Could not read ${file.name} — ${result.error}` }
      }

      onChanged()

      return {
        tone: 'good',
        message: summarize(result.summary),
        detail: rejectionsOf(result.summary),
      }
    })

  const erase = () =>
    run('Erasing', async () => {
      const wiped = await send('backup/wipe', {})

      setConfirmingErase(false)
      onChanged()

      return {
        tone: 'good',
        message: `Erased ${count(wiped.postings, 'record')} and ${count(wiped.snapshots, 'page')}.`,
      }
    })

  return (
    <details className="backup">
      <summary>Backup</summary>

      <p className="backup__last">
        {status === null
          ? 'Checking…'
          : status.lastBackupAt === null
            ? 'No backup has ever been exported.'
            : `Last backup ${formatWhen(status.lastBackupAt)}.`}
      </p>

      <div className="backup__actions">
        <button
          type="button"
          className="button"
          onClick={() => void exportJson('lean')}
          disabled={busy !== null || nothingStored}
        >
          Export records
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void exportJson('full')}
          disabled={busy !== null || nothingStored}
        >
          Export with pages
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => void exportCsv()}
          disabled={busy !== null || nothingStored}
        >
          Spreadsheet
        </button>
      </div>

      {/*
        The variants differ in one way that matters and it is not size. A full
        export carries the pages the records were read from, and those pages
        came off logged-in sessions — decision 6 keeps the demographic
        questionnaire out of them, but they are still somebody's browsing. So
        the hint says which file is safe to hand to another machine.
      */}
      <p className="field__hint">
        <strong>Export records</strong> is the portable one — no page content, safe to keep
        anywhere. <strong>Export with pages</strong> adds the {snapshotCount} saved{' '}
        {snapshotCount === 1 ? 'page' : 'pages'} so a future parser fix can be replayed
        against them.
      </p>

      <label className="backup__import">
        <span className="field__label">Import a backup</span>
        <input
          type="file"
          className="backup__file"
          accept="application/json,.json"
          disabled={busy !== null}
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Cleared straight away so choosing the same file twice fires again
            // — otherwise a failed import cannot be retried without picking a
            // different file first.
            event.target.value = ''
            if (file) void importFile(file)
          }}
        />
        <span className="field__hint">
          Records already here are kept as they are; the file never overwrites them.
        </span>
      </label>

      {busy && (
        <p className="backup__progress" role="status">
          {busy.what}
          {busy.progress && busy.progress.total > 0
            ? ` — ${busy.progress.done} of ${busy.progress.total} ${busy.progress.what}`
            : '…'}
        </p>
      )}

      {outcome && (
        <div
          className={`notice${outcome.tone === 'bad' ? ' notice--bad' : ''}`}
          role={outcome.tone === 'bad' ? 'alert' : 'status'}
        >
          <p>{outcome.message}</p>
          {outcome.tone === 'good' && outcome.detail && (
            <p className="notice__detail">{outcome.detail}</p>
          )}
        </div>
      )}

      <div className="backup__danger">
        {confirmingErase ? (
          /*
            The confirmation is where the weight goes, which is why the resting
            state is a quiet button and this is a full alert. It says the counts
            rather than "are you sure": somebody who has just imported a backup
            and somebody who has four hundred records need different amounts of
            pause, and only the numbers can tell them apart.
          */
          <div className="notice notice--bad" role="alert">
            <p className="notice__title">
              Erase {count(postingCount, 'record')} and {count(snapshotCount, 'page')}?
            </p>
            <p className="notice__detail">
              {status?.lastBackupAt === null
                ? 'Nothing has ever been exported, so this cannot be undone by any means.'
                : 'This cannot be undone. Only an exported file can bring it back.'}
            </p>
            <div className="notice__actions">
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setConfirmingErase(false)}
                disabled={busy !== null}
              >
                Keep it
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void erase()}
                disabled={busy !== null}
              >
                Erase everything
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setConfirmingErase(true)}
            disabled={busy !== null || nothingStored}
          >
            Erase everything
          </button>
        )}
      </div>
    </details>
  )
}

/**
 * States what was written *and* what was left alone.
 *
 * Skipped records are the ordinary outcome of re-importing a backup, not a
 * failure — but silence about them would read as "412 records went in" when 412
 * records did not. Decision 14's whole promise is that an import never
 * overwrites, and this line is where the user sees that promise being kept.
 */
function summarize(summary: ImportSummary): string {
  const parts = [`Imported ${count(summary.postings.imported, 'record')}`]

  if (summary.postings.skipped > 0) {
    parts.push(`kept ${count(summary.postings.skipped, 'record')} already here`)
  }
  if (summary.snapshots.imported > 0) {
    parts.push(`added ${count(summary.snapshots.imported, 'page')}`)
  }

  return `${parts.join(', ')}.`
}

/**
 * Rejections, named rather than counted where there are few of them.
 *
 * A restore that quietly dropped rows would be the worst failure this screen
 * can have, so the reason and the record travel together for the first handful
 * — enough to go and look at the file — and collapse to a count beyond that.
 */
function rejectionsOf(summary: ImportSummary): string | undefined {
  const { rejected } = summary
  if (rejected.length === 0) return undefined

  const shown = rejected
    .slice(0, 3)
    .map((rejection) => `${rejection.at} (${rejection.reason})`)
    .join(', ')

  return rejected.length <= 3
    ? `Could not read ${shown}`
    : `Could not read ${rejected.length} entries: ${shown}, …`
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/** Rounded hard — this is a "how big is that file" answer, not a measurement. */
function bytes(length: number): string {
  if (length < 1024) return `${length} B`
  if (length < 1024 * 1024) return `${Math.round(length / 1024)} KB`

  return `${(length / (1024 * 1024)).toFixed(1)} MB`
}
