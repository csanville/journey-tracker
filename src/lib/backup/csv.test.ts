import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../types'
import type { Posting } from '../types'
import { cell, toCsv } from './csv'

function aRecord(overrides: Partial<Posting> = {}): Posting {
  return {
    id: 'rec-1',
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date(2026, 2, 14, 9, 30).getTime(),
    updatedAt: new Date(2026, 2, 15, 9, 30).getTime(),
    company: 'Initech',
    companyNormalized: 'initech',
    jobTitle: 'Staff Engineer',
    location: 'Austin, TX',
    workMode: 'hybrid',
    atsReqId: 'REQ-4021',
    salary: {
      min: 180_000,
      max: 220_000,
      currency: 'USD',
      period: 'year',
      raw: '$180k–$220k',
    },
    url: 'https://boards.greenhouse.io/initech/jobs/4021',
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    source: 'greenhouse',
    sourceConfidence: 0.8,
    adapterVersion: 'greenhouse@1',
    state: 'applied',
    appliedAt: new Date(2026, 2, 15).getTime(),
    stage: 'interviewing',
    outcome: null,
    resumeUsed: 'backend-2026',
    notes: null,
    tags: ['backend', 'remote-ok'],
    ...overrides,
  }
}

/** Rows without the BOM, split on the CRLF the format is written with. */
function rows(csv: string): string[] {
  return csv.replace(/^﻿/, '').trimEnd().split('\r\n')
}

describe('toCsv', () => {
  it('writes a header row and one row per record', () => {
    const lines = rows(toCsv([aRecord(), aRecord({ id: 'rec-2' })]))

    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^Company,Job title,Status,/)
    expect(lines[1]).toMatch(/^Initech,Staff Engineer,applied,/)
  })

  /**
   * Without the mark Excel decodes the file as the system codepage, and every
   * accented company name and en-dashed salary range arrives as mojibake.
   */
  it('starts with a UTF-8 byte order mark, for Excel', () => {
    expect(toCsv([])).toMatch(/^﻿/)
  })

  it('separates rows with CRLF and terminates the last one', () => {
    expect(toCsv([aRecord()])).toMatch(/\r\n$/)
  })

  it('reports an empty database as a header and nothing else', () => {
    expect(rows(toCsv([]))).toHaveLength(1)
  })

  it('writes dates in the user’s own timezone, ISO-ordered so they sort', () => {
    const line = rows(toCsv([aRecord()]))[1] ?? ''

    expect(line).toContain('2026-03-15')
    expect(line).toContain('2026-03-14')
  })

  it('leaves the date empty on a record that was never applied to', () => {
    const line = rows(toCsv([aRecord({ state: 'viewed', appliedAt: null })]))[1] ?? ''

    expect(line).toMatch(/^Initech,Staff Engineer,viewed,,"Austin, TX"/)
  })

  it('splits a structured salary into columns a spreadsheet can total', () => {
    const line = rows(toCsv([aRecord()]))[1] ?? ''

    expect(line).toContain('180000,220000,USD,year')
  })
})

describe('cell', () => {
  it('leaves an ordinary value unquoted, so the file reads in a text editor', () => {
    expect(cell('Initech')).toBe('Initech')
  })

  it('quotes and doubles up on the characters that would break a row', () => {
    expect(cell('Austin, TX')).toBe('"Austin, TX"')
    expect(cell('the "senior" one')).toBe('"the ""senior"" one"')
    expect(cell('two\nlines')).toBe('"two\nlines"')
  })

  /**
   * Every string in a record came off a web page, and a cell opening with `=`
   * is a formula the moment the file is opened — one that can reach the
   * network. The apostrophe is the marker spreadsheets themselves use, and it
   * is hidden in the grid.
   */
  describe('formula injection', () => {
    it('disarms the four characters a spreadsheet would evaluate', () => {
      // Quoted as well as disarmed, because it also carries quotes and commas.
      expect(cell('=HYPERLINK("http://evil","click")')).toMatch(/^"'=/)
      expect(cell('+1234')).toBe("'+1234")
      expect(cell('-1234')).toBe("'-1234")
      expect(cell('@SUM(A1)')).toBe("'@SUM(A1)")
    })

    /**
     * Any leading whitespace, not the two characters an earlier version named.
     * Spreadsheets trim a field before deciding what it is, so a single leading
     * space — entirely ordinary in scraped markup — walked straight through the
     * guard written to stop exactly this.
     */
    it('disarms leading whitespace that would lead into one', () => {
      expect(cell('\t=1+1')).toMatch(/^'/)
      expect(cell(' =HYPERLINK("http://evil","click")')).toMatch(/^"?'/)
      expect(cell('  +1234')).toBe("'  +1234")
      expect(cell('\n=1+1')).toMatch(/^"'/)
    })

    /**
     * This fires on ordinary text too — a note beginning "- called back" is
     * perfectly normal — and that is the right direction to be wrong in.
     */
    it('accepts that it fires on innocent text as well', () => {
      expect(cell('- called back')).toBe("'- called back")
    })

    it('still quotes a disarmed value that also needs quoting', () => {
      expect(cell('=one, two')).toBe('"\'=one, two"')
    })
  })
})
