import { describe, expect, it } from 'vitest'
import { inferWorkMode, workModeFromLocationType } from './workmode'

describe('inferWorkMode', () => {
  it('reads the location strings the real boards emit', () => {
    // Straight out of the checked-in Greenhouse capture.
    expect(inferWorkMode('San Francisco Bay Area or New York (Remote (U.S.))')).toBe(
      'remote',
    )
    expect(inferWorkMode('Bay Area, CA')).toBeNull()
    expect(inferWorkMode('London — Hybrid')).toBe('hybrid')
    expect(inferWorkMode('Austin, TX (On-site)')).toBe('onsite')
    expect(inferWorkMode('Austin, TX (Onsite)')).toBe('onsite')
  })

  it('prefers hybrid when a posting says both', () => {
    // "Hybrid — 2 days remote" is a hybrid role describing itself, and "Remote
    // or hybrid" will take either. Calling both hybrid is right more often.
    expect(inferWorkMode('Hybrid — 2 days remote')).toBe('hybrid')
    expect(inferWorkMode('Remote or hybrid')).toBe('hybrid')
  })

  it('does not fire on an ordinary word that contains a keyword', () => {
    // The lesson decision 7 records from the normalization layer: the traps are
    // all ordinary words. Without word boundaries these would all match.
    expect(inferWorkMode('Bremerton, WA')).toBeNull()
    expect(inferWorkMode('Onsited Systems Ltd')).toBeNull()
    expect(inferWorkMode('Hybridge, NJ')).toBeNull()
  })

  it('takes the first value that says anything, across several fields', () => {
    expect(inferWorkMode(null, 'Remote', 'Berlin')).toBe('remote')
    expect(inferWorkMode(null, undefined, '')).toBeNull()
  })
})

describe('workModeFromLocationType', () => {
  it('reads schema.org’s one defined value', () => {
    expect(workModeFromLocationType('TELECOMMUTE')).toBe('remote')
  })

  it('says nothing about anything else', () => {
    // There is no schema.org term for hybrid or onsite, so an unrecognised
    // value is not evidence of an office.
    expect(workModeFromLocationType('ONSITE')).toBeNull()
    expect(workModeFromLocationType(null)).toBeNull()
    expect(workModeFromLocationType(42)).toBeNull()
  })
})
