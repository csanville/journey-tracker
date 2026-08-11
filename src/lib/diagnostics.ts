/**
 * The report a user can send when the extension gets a page wrong.
 *
 * Decision 1 bought "does not collect user data" by giving up crash reporting
 * and analytics, and named this as the one mitigation: adapter versions, the
 * failing hostname and a redacted parse result, on the clipboard, for the user
 * to paste where they choose. This module is that payload and nothing else — it
 * reads no storage, touches no `chrome` API and knows nothing about how the page
 * was reached. Everything it needs is passed in, which is what makes the
 * redaction testable without a browser.
 *
 * **This is the only egress path in the product, and the product's claim is that
 * there is none.** Three rules follow from that, and all three are load-bearing:
 *
 * - **Allowlist, never denylist.** Every field is named and copied one at a
 *   time. Nothing here spreads `...status` or `...extraction`, because a spread
 *   makes the payload grow silently whenever a type upstream does — and a record
 *   has already gained fields twice under migration. A denylist fails open; this
 *   fails closed, and `diagnostics.test.ts` seeds every input with sentinel
 *   values and asserts none of them reach the output.
 * - **Shapes, never values.** What went wrong with a parse is which tier
 *   answered which field, and that is `provenance` — tier names, never the text
 *   they read. The company, the job title, the location and the salary are the
 *   user's job search and are never in here at all.
 * - **The redaction happens here, not at the caller.** `buildReport` takes the
 *   full URL and reduces it to a hostname itself. A caller that had to pass a
 *   host could pass the whole URL by mistake, and that mistake would look
 *   exactly like working code.
 *
 * The hostname is the one identifying thing that survives, and on a board it
 * identifies nothing — `job-boards.greenhouse.io` names no employer. On a
 * company's own careers page it does name the employer, and there is no version
 * of this that both fixes an adapter and hides which site it failed on. That is
 * the reason the panel renders the report before it copies it: the judgement is
 * the user's, and they cannot make it on a clipboard they have not read.
 */

import { FIELD_NAMES, type FieldName, type Tier } from './extract/types'
import type { StatusReport } from './messages'

/**
 * Why there is no parse to report.
 *
 * A closed set rather than the error that was caught, and that is a redaction
 * rule and not tidiness: Chrome's own injection failures read `Cannot access
 * contents of url "https://…"`, so passing a message through would put the full
 * URL into the payload by the one route that never looks like a leak.
 *
 * **One value, and the two that were cut are the more interesting half.** The
 * first draft also had `restricted-page` and `no-response`, for a `chrome://`
 * tab that refuses injection and an injection that never answered. Neither is
 * reachable. The panel does not trigger reads — the context menu does, through
 * the worker — so it never learns that one was refused; and the worker, having
 * no `tabs` permission, cannot supply the URL and adapter a report needs. Both
 * were written because they sound like things that happen, which is the same
 * reason the panel nearly grew a button that could not work.
 */
export type UnreachableReason =
  /**
   * Nothing has read this page: not a board the manifest matches, and nobody
   * has right-clicked it. The ordinary state of most tabs, and not a fault.
   */
  'not-read'

/**
 * The part of a parse a report is allowed to see.
 *
 * Narrower than `Extraction` on purpose, and the narrowing is the point: there
 * is no `fields` on it, so the builder is never handed a company name or a
 * salary in the first place. An allowlist applied *after* the values arrive can
 * be got wrong; a parameter that cannot carry them cannot.
 *
 * `Extraction`, `DetectionSummary` and `CachedFailedParse` all satisfy it
 * structurally, which is what lets one builder serve a page that parsed and a
 * page that did not.
 */
export interface ParsedPage {
  source: string
  adapterVersion: string
  confidence: number
  provenance: Record<FieldName, Tier | null>
}

/** What the adapters made of the page, or why nothing did. */
export type PageParse =
  { read: true; parse: ParsedPage } | { read: false; reason: UnreachableReason }

export interface DiagnosticsInput {
  /** Supplied rather than read from the clock, so the output is a pure function. */
  at: number
  /** `chrome.runtime.getManifest().version`, read by the caller. */
  extensionVersion: string
  /**
   * The full URL, reduced to a hostname *here* — see the note above.
   *
   * `null` when the extension has no URL for this tab, which is the ordinary
   * case rather than a failure: without the `tabs` permission the only URLs it
   * ever learns are the ones a content script reported about itself.
   */
  url: string | null
  status: StatusReport
  parse: PageParse
}

/** The page, after redaction. Both fields are `null` on a URL that will not parse. */
export interface PageFacts {
  /** Hostname only: no path, no query, no port, no credentials. */
  host: string | null
  /** `https:`, `file:`, `chrome:`. Explains a whole class of failure at a glance. */
  scheme: string | null
}

export interface ParseFacts {
  source: string
  adapterVersion: string
  confidence: number
  /**
   * Which tier answered each field, `null` where none did.
   *
   * Deliberately the only per-field thing reported. A list of which fields came
   * back is the same information — `mergeTiers` sets a field and its provenance
   * in the same step, so a non-null field and a non-null tier are the same
   * condition — and phase 10 already deleted one payload that restated something
   * written down elsewhere.
   */
  provenance: Record<FieldName, Tier | null>
}

export interface InstallFacts {
  schemaVersion: number
  dataVersion: number
  migrationInProgress: boolean
  evictionSafe: boolean
  storagePersisted: boolean | null
  storageUnlimited: boolean | null
  postingCount: number
  snapshotCount: number
  /**
   * Disk used by the whole origin, and the quota. Safe to send: it is a rounded
   * number about the user's own machine, and `postingCount` beside it already
   * says more about the size of their job search than this does.
   */
  usageBytes: number | null
  quotaBytes: number | null
}

/**
 * Everything that may leave the device, and nothing else.
 *
 * `lastBackupAt` is on `StatusReport` and is deliberately not here: it is a date
 * the user did something, it says nothing about why a page failed to parse, and
 * the smallest payload that answers the question is the one to send. Add it when
 * a report needs it, not in case one might.
 */
export interface DiagnosticsReport {
  at: number
  extensionVersion: string
  page: PageFacts
  /** `null` when the page could not be read; `unreachable` then says why. */
  parse: ParseFacts | null
  unreachable: UnreachableReason | null
  install: InstallFacts
}

/**
 * Reduces a URL to the two parts that are safe to send.
 *
 * `hostname` rather than `host` drops the port, and drops any `user:pass@`
 * with it. An unparseable URL yields nulls rather than throwing — a diagnostic
 * that fails on a strange page is a diagnostic missing at exactly the moment it
 * was wanted.
 */
function redactUrl(url: string | null): PageFacts {
  if (url === null) return { host: null, scheme: null }

  try {
    const parsed = new URL(url)
    return { host: parsed.hostname, scheme: parsed.protocol }
  } catch {
    return { host: null, scheme: null }
  }
}

/**
 * Copies the tier names across one field at a time.
 *
 * Iterating `FIELD_NAMES` rather than the object's own keys means a field added
 * to `ExtractedFields` later arrives here as a tier name — which is safe by
 * construction, since the value never comes with it — while anything the
 * extraction happens to be carrying that is *not* a declared field is dropped.
 */
function redactProvenance(
  provenance: Record<FieldName, Tier | null>,
): Record<FieldName, Tier | null> {
  const copy = {} as Record<FieldName, Tier | null>
  for (const name of FIELD_NAMES) copy[name] = provenance[name] ?? null
  return copy
}

export function buildReport(input: DiagnosticsInput): DiagnosticsReport {
  const { status } = input

  return {
    at: input.at,
    extensionVersion: input.extensionVersion,
    page: redactUrl(input.url),
    parse: input.parse.read
      ? {
          source: input.parse.parse.source,
          adapterVersion: input.parse.parse.adapterVersion,
          confidence: input.parse.parse.confidence,
          provenance: redactProvenance(input.parse.parse.provenance),
        }
      : null,
    unreachable: input.parse.read ? null : input.parse.reason,
    install: {
      schemaVersion: status.schemaVersion,
      dataVersion: status.dataVersion,
      migrationInProgress: status.migrationInProgress,
      evictionSafe: status.evictionSafe,
      storagePersisted: status.storagePersisted,
      storageUnlimited: status.storageUnlimited,
      postingCount: status.postingCount,
      snapshotCount: status.snapshotCount,
      usageBytes: status.usageBytes,
      quotaBytes: status.quotaBytes,
    },
  }
}

/**
 * Bytes, at the precision the number deserves.
 *
 * Chrome rounds and pads what `estimate()` reports on purpose, to make
 * cross-origin storage fingerprinting harder, so printing every digit would
 * dress a deliberate approximation as a measurement. One decimal place at MB
 * and above says what it knows and no more.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * Whether this parse would have been offered to the user.
 *
 * The same condition as `isWorthOffering`, read off provenance instead of off
 * the values — company or job title, either alone is enough. Derived rather than
 * carried for the reason `ParseFacts` gives, and worth stating in the report
 * because it is the exact gate that produced the silence the user is complaining
 * about.
 */
function wouldOffer(provenance: Record<FieldName, Tier | null>): boolean {
  return provenance.company !== null || provenance.jobTitle !== null
}

function storageLine(install: InstallFacts): string {
  if (!install.evictionSafe) return 'evictable'
  return install.storageUnlimited ? 'protected (unlimitedStorage)' : 'protected (persisted)'
}

const LABEL_WIDTH = 11

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`
}

/**
 * The clipboard text.
 *
 * Plain, aligned and unfenced. It is pasted into an issue by hand, so it reads
 * without a renderer and does not assume one — wrapping it in a code fence is
 * the pasting user's call, and a fence pasted into a plain textarea is noise.
 */
export function formatReport(report: DiagnosticsReport): string {
  const rows: string[] = [
    `JourneyTracker diagnostics · ${new Date(report.at).toISOString()}`,
    '',
    line(
      'page',
      report.page.host === null
        ? 'not reported'
        : `${report.page.host} (${report.page.scheme ?? '?'})`,
    ),
    line('extension', report.extensionVersion),
    line(
      'schema',
      `v${report.install.schemaVersion}, data at v${report.install.dataVersion}${
        report.install.migrationInProgress ? ', migrating' : ''
      }`,
    ),
    line('storage', storageLine(report.install)),
    line(
      'records',
      `${report.install.postingCount} postings, ${report.install.snapshotCount} snapshots`,
    ),
    // The origin's total, not the snapshot store's — see `readStorageUsage`.
    // Reported next to the snapshot count because that pair is what decision 6's
    // open question is decided on.
    line(
      'on disk',
      `${formatBytes(report.install.usageBytes)} of ${formatBytes(report.install.quotaBytes)}`,
    ),
    '',
  ]

  if (report.parse === null) {
    rows.push(line('parse', `none — ${report.unreachable ?? 'unknown'}`))
    return rows.join('\n')
  }

  rows.push(
    line('adapter', report.parse.adapterVersion),
    line('coverage', report.parse.confidence.toFixed(2)),
    line(
      'offered',
      wouldOffer(report.parse.provenance) ? 'yes' : 'no — needs a company or a job title',
    ),
    '',
  )

  for (const name of FIELD_NAMES) {
    rows.push(line(name, report.parse.provenance[name] ?? 'not found'))
  }

  return rows.join('\n')
}
