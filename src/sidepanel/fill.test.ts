import { describe, expect, it } from 'vitest'
import type { DetectionSummary } from '../lib/detection'
import { EMPTY_DRAFT, toPostingInput, type Draft } from './draft'
import { draftFromDetection, fieldsFilled, saveContextFor, swapAction } from './fill'

function aDetection(overrides: Partial<DetectionSummary> = {}): DetectionSummary {
  return {
    detectionId: 'det-1',
    url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
    source: 'lever',
    adapterVersion: 'lever@1',
    confidence: 0.71,
    capturedAt: 1000,
    snapshotBytes: 2048,
    fields: {
      company: 'Acme',
      jobTitle: 'Staff Engineer',
      location: 'Berlin',
      workMode: 'hybrid',
      atsReqId: null,
      salary: null,
    },
    provenance: {
      company: 'jsonld',
      jobTitle: 'jsonld',
      location: 'jsonld',
      workMode: 'dom',
      atsReqId: null,
      salary: null,
    },
    ...overrides,
  }
}

describe('draftFromDetection', () => {
  it('fills the fields a page can answer', () => {
    const draft = draftFromDetection(aDetection())

    expect(draft).toMatchObject({
      company: 'Acme',
      jobTitle: 'Staff Engineer',
      location: 'Berlin',
      workMode: 'hybrid',
      url: 'https://jobs.lever.co/acme/00000000-0000-4000-8000-000000000000',
    })
  })

  it('leaves everything the page cannot know about alone', () => {
    // A job board has no opinion about whether you applied, which resume you
    // sent, or what you thought of the description.
    const started: Draft = {
      ...EMPTY_DRAFT,
      state: 'applied',
      appliedAt: '2026-07-01',
      resumeUsed: 'backend-2026',
      notes: 'Referred by Sam',
      tags: 'priority',
    }

    expect(draftFromDetection(aDetection(), started)).toMatchObject({
      company: 'Acme',
      state: 'applied',
      appliedAt: '2026-07-01',
      resumeUsed: 'backend-2026',
      notes: 'Referred by Sam',
      tags: 'priority',
    })
  })

  it('does not clear a field the page had nothing to say about', () => {
    // `null` from an adapter means "the page did not say", never "there is
    // nothing there" — so blanking the user's own answer would be reading it
    // backwards.
    const quiet = aDetection()
    quiet.fields = { ...quiet.fields, location: null, workMode: null }

    const draft = draftFromDetection(quiet, {
      ...EMPTY_DRAFT,
      location: 'Somewhere I typed',
      workMode: 'remote',
    })

    expect(draft).toMatchObject({ location: 'Somewhere I typed', workMode: 'remote' })
  })

  it('carries the salary the adapter parsed into the visible field', () => {
    const paid = aDetection()
    paid.fields = {
      ...paid.fields,
      salary: {
        min: 180000,
        max: 220000,
        currency: 'USD',
        period: 'year',
        raw: 'USD 180,000–USD 220,000 per year',
      },
    }

    expect(draftFromDetection(paid).salary).toBe('USD 180,000–USD 220,000 per year')
  })
})

describe('fieldsFilled', () => {
  it('counts only what a fill would actually change', () => {
    expect(fieldsFilled(aDetection(), EMPTY_DRAFT)).toEqual([
      'company',
      'jobTitle',
      'url',
      'location',
      'workMode',
    ])

    const already = draftFromDetection(aDetection())
    expect(fieldsFilled(aDetection(), already)).toEqual([])
  })
})

describe('saveContextFor', () => {
  it('records which adapter produced the record', () => {
    // Decision 6: a parser fix has to be able to find the records it should
    // replay, and `manual@1` records are not among them.
    const context = saveContextFor(aDetection(), draftFromDetection(aDetection()))

    expect(context).toMatchObject({
      source: 'lever',
      adapterVersion: 'lever@1',
      sourceConfidence: 0.71,
    })
  })

  it('keeps the structured salary while the field still says what it said', () => {
    const paid = aDetection()
    const salary = {
      min: 180000,
      max: 220000,
      currency: 'USD',
      period: 'year' as const,
      raw: 'USD 180,000–USD 220,000 per year',
    }
    paid.fields = { ...paid.fields, salary }

    const draft = draftFromDetection(paid)
    const posting = toPostingInput(draft, 'id-1', saveContextFor(paid, draft))

    // The form is all strings, so without this the range, currency and period
    // are thrown away the moment they are shown to somebody.
    expect(posting.salary).toEqual(salary)
  })

  it('drops the structured salary once the user has typed over it', () => {
    const paid = aDetection()
    paid.fields = {
      ...paid.fields,
      salary: {
        min: 180000,
        max: 220000,
        currency: 'USD',
        period: 'year',
        raw: 'USD 180,000–USD 220,000 per year',
      },
    }

    const edited = { ...draftFromDetection(paid), salary: '£95,000 plus equity' }
    const posting = toPostingInput(edited, 'id-1', saveContextFor(paid, edited))

    expect(posting.salary).toEqual({
      min: null,
      max: null,
      currency: null,
      period: null,
      raw: '£95,000 plus equity',
    })
  })

  it('still records manual provenance for a hand-typed record', () => {
    const posting = toPostingInput({ ...EMPTY_DRAFT, company: 'Acme', jobTitle: 'Eng' })

    expect(posting).toMatchObject({ source: 'manual', adapterVersion: 'manual@1' })
  })
})

describe('swapAction', () => {
  const base = { offered: true, dirty: false, busy: false, dismissed: false }

  it('fills a pristine form without asking', () => {
    expect(swapAction(base)).toBe('fill')
  })

  it('fills a form that was auto-filled and left alone', () => {
    // The case the whole rule exists for. After a fill the draft equals its own
    // baseline, so `dirty` is false while the form is full — and tabbing from
    // one posting to another must move the form, not announce at it.
    expect(swapAction({ ...base, dirty: false })).toBe('fill')
  })

  it('announces rather than overwriting typed work', () => {
    expect(swapAction({ ...base, dirty: true })).toBe('announce')
  })

  it('does nothing while a save is in flight', () => {
    // The draft has already been snapshotted for writing. A fill landing in the
    // gap is saved as the pre-fill values and then wiped by the reset — which
    // is worse than not filling, because it looks like it worked.
    expect(swapAction({ ...base, busy: true })).toBe('nothing')
    expect(swapAction({ ...base, busy: true, dirty: true })).toBe('nothing')
  })

  it('does not resurrect a banner the user folded away', () => {
    expect(swapAction({ ...base, dismissed: true })).toBe('nothing')
  })

  it('still announces a dismissed posting once work has been typed', () => {
    // Dismissing says "not this one, not now". It does not license overwriting
    // what was typed afterwards, and the fall-through must not reach `fill`.
    expect(swapAction({ ...base, dismissed: true, dirty: true })).toBe('announce')
  })

  it('does nothing when there is nothing on offer', () => {
    expect(swapAction({ ...base, offered: false })).toBe('nothing')
  })
})
