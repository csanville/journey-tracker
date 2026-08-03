import { describe, expect, it, vi } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import type { DetectionSummary } from './detection'
import { findDuplicate } from './repository'
import { postingInputFromDetection, setTrackedBadge } from './tracked'

function aDetection(overrides: Partial<DetectionSummary> = {}): DetectionSummary {
  return {
    detectionId: 'det-1',
    url: 'https://boards.greenhouse.io/initech/jobs/4021?utm_source=twitter',
    source: 'greenhouse',
    adapterVersion: 'greenhouse@1',
    confidence: 0.8,
    capturedAt: 1_700_000_000_000,
    snapshotBytes: 2048,
    fields: {
      company: 'Initech',
      jobTitle: 'Staff Engineer',
      location: 'Austin, TX',
      workMode: 'hybrid',
      atsReqId: 'REQ-4021',
      salary: null,
    },
    provenance: {
      company: 'jsonld',
      jobTitle: 'jsonld',
      location: 'dom',
      workMode: null,
      atsReqId: null,
      salary: null,
    },
    ...overrides,
  }
}

describe('postingInputFromDetection', () => {
  it('carries the four fields the duplicate search keys on', () => {
    const input = postingInputFromDetection(aDetection(), 'query-id')

    expect(input.company).toBe('Initech')
    expect(input.jobTitle).toBe('Staff Engineer')
    expect(input.atsReqId).toBe('REQ-4021')
    expect(input.url).toBe(
      'https://boards.greenhouse.io/initech/jobs/4021?utm_source=twitter',
    )
  })

  it('is neutral about everything only the user could know', () => {
    // A page has no opinion on whether you applied to it. If any of this
    // leaked into the query it would be a claim about the user's own history
    // made by a job board.
    const input = postingInputFromDetection(aDetection(), 'query-id')

    expect(input.state).toBe('viewed')
    expect(input.appliedAt).toBeNull()
    expect(input.resumeUsed).toBeNull()
    expect(input.notes).toBeNull()
    expect(input.tags).toEqual([])
  })

  it('tolerates a detection that named only one of company and title', () => {
    const input = postingInputFromDetection(
      aDetection({ fields: { ...aDetection().fields, company: null } }),
      'query-id',
    )

    expect(input.company).toBe('')
    expect(input.jobTitle).toBe('Staff Engineer')
  })

  it('gives every stored posting a chance to match', async () => {
    // `findDuplicate` excludes the record whose id it is handed, so that a
    // record cannot match itself. A detection has no id to exclude — if the
    // default collided with a stored one, the very record being looked for
    // would be the one filtered out.
    const db = await freshDb()
    const stored = aPosting({ id: 'stored-1' })
    await db.postings.add({
      ...stored,
      companyNormalized: 'initech',
      canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
      schemaVersion: 2,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const match = await findDuplicate(db, postingInputFromDetection(aDetection()))

    expect(match?.posting.id).toBe('stored-1')
    // The tracking parameter differs; canonicalization is what collapses them.
    expect(match?.matchedOn).toBe('url')
  })
})

describe('setTrackedBadge', () => {
  it('marks the tab it was given and colours the mark', async () => {
    await setTrackedBadge(7, true)

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '✓' })
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledOnce()
  })

  it('clears the mark rather than leaving a stale one', async () => {
    await setTrackedBadge(7, false)

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '' })
    // Nothing to colour, and setting a colour on an empty badge would leave a
    // tinted gap on some Chrome versions.
    expect(chrome.action.setBadgeBackgroundColor).not.toHaveBeenCalled()
  })

  it('is scoped to a tab, never global', async () => {
    // A global badge would need repainting on every tab switch and would be
    // wrong in the gap. Chrome scopes a tab-scoped badge for us.
    await setTrackedBadge(3, true)

    expect(vi.mocked(chrome.action.setBadgeText).mock.calls.at(0)?.[0]).toHaveProperty(
      'tabId',
      3,
    )
  })
})
