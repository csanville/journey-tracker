/**
 * The spreadsheet report.
 *
 * One-way, and deliberately so (decision 14). CSV mangles dates, eats the
 * leading zeros off requisition ids, and cannot carry a snapshot at all — fine
 * for reading, unacceptable for restoring, which is what the JSON bundle is
 * for. Nothing here is ever parsed back in, so the format optimises entirely
 * for opening cleanly in Excel and Sheets.
 *
 * Three things that are easy to get wrong and are the reason this is a module
 * rather than a `map().join(',')`:
 *
 * - **The BOM.** Without a UTF-8 byte order mark Excel decodes the file as the
 *   system codepage, and every accented company name and en dash in a salary
 *   range arrives as mojibake.
 * - **CRLF.** RFC 4180, and the line ending older Excel builds need to see a
 *   row break rather than a stray character inside a cell.
 * - **Formula injection.** Every string in a record came off a web page. A
 *   title beginning `=` or `+` is a formula the moment the file is opened, and
 *   spreadsheet formulas can reach the network. See `neutralize`.
 */
import type { Posting } from '../types'

/** Excel needs this to read the file as UTF-8. Nothing else cares. */
const BOM = '﻿'

const CRLF = '\r\n'

interface Column {
  header: string
  value: (posting: Posting) => string
}

/**
 * Ordered for reading, not for machines: what the job was, then what happened
 * to it, then the details, then the bookkeeping. The id comes last so a row can
 * still be matched back to the JSON export when someone needs to.
 */
const COLUMNS: Column[] = [
  { header: 'Company', value: (p) => p.company },
  { header: 'Job title', value: (p) => p.jobTitle },
  { header: 'Status', value: (p) => p.state },
  { header: 'Applied on', value: (p) => day(p.appliedAt) },
  { header: 'Location', value: (p) => p.location ?? '' },
  { header: 'Work mode', value: (p) => p.workMode ?? '' },
  { header: 'Salary min', value: (p) => number(p.salary?.min) },
  { header: 'Salary max', value: (p) => number(p.salary?.max) },
  { header: 'Currency', value: (p) => p.salary?.currency ?? '' },
  { header: 'Per', value: (p) => p.salary?.period ?? '' },
  { header: 'Salary as written', value: (p) => p.salary?.raw ?? '' },
  { header: 'Req ID', value: (p) => p.atsReqId ?? '' },
  { header: 'URL', value: (p) => p.url },
  { header: 'Resume', value: (p) => p.resumeUsed ?? '' },
  { header: 'Tags', value: (p) => p.tags.join(', ') },
  { header: 'Notes', value: (p) => p.notes ?? '' },
  { header: 'Read by', value: (p) => p.source },
  { header: 'Saved on', value: (p) => day(p.createdAt) },
  { header: 'Updated on', value: (p) => day(p.updatedAt) },
  { header: 'Record id', value: (p) => p.id },
]

/**
 * The whole report as one string, header row first.
 *
 * Rows are in whatever order the caller lists them, which is the panel's
 * newest-first — sorting is a thing spreadsheets do well and this should not
 * have an opinion about.
 */
export function toCsv(postings: Posting[]): string {
  const rows = [
    COLUMNS.map((column) => cell(column.header)),
    ...postings.map((posting) => COLUMNS.map((column) => cell(column.value(posting)))),
  ]

  // A trailing break so the last row is a row rather than a fragment; tools
  // disagree about an unterminated final line and none of them mind this one.
  return BOM + rows.map((row) => row.join(',')).join(CRLF) + CRLF
}

/**
 * One field, quoted when it has to be and disarmed when it might not be data.
 *
 * Quoting is decided by content rather than applied to everything, because a
 * file where every cell is quoted is harder for a person to read in a text
 * editor, and reading it in a text editor is half of what this format is for.
 */
export function cell(value: string): string {
  const text = neutralize(value)

  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * Stops a spreadsheet treating a scraped string as a formula.
 *
 * Excel and Sheets both evaluate a cell that opens with `=`, `+`, `-` or `@`,
 * and a formula is not inert: `=HYPERLINK`, `=IMPORTDATA` and friends can reach
 * the network, so a job title chosen by whoever wrote the posting would be
 * running when the user opens their own backup. Tab and carriage return lead
 * the same way once a cell is being parsed.
 *
 * The fix is the one spreadsheets themselves use: a leading apostrophe, which
 * marks the cell as text and is hidden in the grid. It is visible to a plain
 * text reader, which is the honest cost — and cheaper than the alternative,
 * since this file is a report and not something that gets parsed back.
 *
 * Real strings that start this way exist — a note beginning "- called back" is
 * ordinary — so this fires more often than an attack would. That is the right
 * direction to be wrong in.
 */
function neutralize(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/** A number a spreadsheet can compute with, or an empty cell. */
function number(value: number | null | undefined): string {
  return typeof value === 'number' ? String(value) : ''
}

/**
 * `YYYY-MM-DD` in the user's own timezone.
 *
 * Local rather than UTC for the same reason the form parses dates locally: the
 * user applied on a calendar day where they were standing, and shifting it back
 * over the dateline for anyone west of Greenwich makes a funnel report subtly
 * wrong at exactly the boundaries people check.
 *
 * ISO order rather than a locale format because it sorts as text, and a report
 * whose date column sorts wrong is a report nobody trusts.
 */
function day(at: number | null): string {
  if (at === null) return ''

  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''

  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')

  return `${date.getFullYear()}-${month}-${dayOfMonth}`
}
