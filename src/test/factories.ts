import { JourneyTrackerDb } from '../lib/db'
import type { PostingInput } from '../lib/types'

let counter = 0

/** A uniquely named database per test, so cases cannot leak into each other. */
export async function freshDb(): Promise<JourneyTrackerDb> {
  const db = new JourneyTrackerDb(`jt-test-${Date.now()}-${counter++}`)
  await db.open()
  return db
}

/**
 * A realistic posting. The URL carries a tracking parameter its canonical form
 * lacks, because that gap is the whole point of the phase 2 normalizer and
 * fixtures that ignore it would flatter the dedupe tests.
 */
export function aPosting(overrides: Partial<PostingInput> = {}): PostingInput {
  return {
    id: `posting-${counter++}`,
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
      raw: '$180,000 — $220,000 a year',
    },
    url: 'https://boards.greenhouse.io/initech/jobs/4021?utm_source=linkedin',
    canonicalUrl: 'https://boards.greenhouse.io/initech/jobs/4021',
    source: 'manual',
    sourceConfidence: 1,
    adapterVersion: 'manual@1',
    state: 'viewed',
    appliedAt: null,
    resumeUsed: null,
    notes: null,
    tags: [],
    ...overrides,
  }
}
