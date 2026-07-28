import { describe, expect, it } from 'vitest'
import { canonicalizeUrl, isUsableUrlKey } from './url'

/** Spellings of one posting that must collapse to a single canonical URL. */
const COLLAPSE: Array<{ what: string; variants: string[] }> = [
  {
    what: 'utm campaign parameters',
    variants: [
      'https://boards.greenhouse.io/acme/jobs/4012345',
      'https://boards.greenhouse.io/acme/jobs/4012345?utm_source=linkedin&utm_medium=social',
      'https://boards.greenhouse.io/acme/jobs/4012345?utm_campaign=spring&utm_content=a',
    ],
  },
  {
    what: 'an ad-network click id',
    variants: [
      'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456',
      'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456?gclid=abc123',
      'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456?fbclid=xyz',
    ],
  },
  {
    what: 'a Greenhouse traffic source, which is not the job id',
    variants: [
      'https://boards.greenhouse.io/acme/jobs/4012345',
      'https://boards.greenhouse.io/acme/jobs/4012345?gh_src=abc123',
    ],
  },
  {
    what: 'a Lever referral breadcrumb',
    variants: [
      'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456',
      'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456?lever-source=Indeed',
    ],
  },
  {
    what: 'LinkedIn per-impression noise',
    variants: [
      'https://www.linkedin.com/jobs/view/3812345678',
      'https://www.linkedin.com/jobs/view/3812345678?refId=abc%3D&trackingId=xyz%3D&pageNum=0',
    ],
  },
  {
    what: 'scheme, www and a trailing slash',
    variants: [
      'https://boards.greenhouse.io/acme/jobs/4012345',
      'http://boards.greenhouse.io/acme/jobs/4012345',
      'https://www.boards.greenhouse.io/acme/jobs/4012345/',
      '  https://boards.greenhouse.io/acme/jobs/4012345  ',
    ],
  },
  {
    what: 'parameter order',
    variants: [
      'https://example.com/careers?a=1&b=2',
      'https://example.com/careers?b=2&a=1',
    ],
  },
  {
    what: 'a scroll-target fragment',
    variants: [
      'https://example.com/careers/engineer',
      'https://example.com/careers/engineer#apply',
      'https://example.com/careers/engineer#content',
    ],
  },
]

/**
 * The half that matters more: URLs a sloppier canonicalizer would merge, each of
 * which is a genuinely different posting.
 */
const DISTINCT: Array<[string, string, string]> = [
  [
    'different Greenhouse job ids',
    'https://boards.greenhouse.io/acme/jobs/4012345',
    'https://boards.greenhouse.io/acme/jobs/4012346',
  ],
  [
    'the embedded job id is not a tracking parameter',
    'https://acme.com/careers?gh_jid=4012345',
    'https://acme.com/careers?gh_jid=4012346',
  ],
  [
    'the Ashby job id is not a tracking parameter',
    'https://acme.com/careers?ashby_jid=0f0e2b1a-1234-4c8d-9e0f-abcdef123456',
    'https://acme.com/careers?ashby_jid=1a2b3c4d-5678-4c8d-9e0f-abcdef123456',
  ],
  [
    'a routing fragment identifies the posting',
    'https://acme.com/careers#/job/4012345',
    'https://acme.com/careers#/job/4012346',
  ],
  [
    'different boards on the same host',
    'https://boards.greenhouse.io/acme/jobs/4012345',
    'https://boards.greenhouse.io/other/jobs/4012345',
  ],
  [
    'a company subdomain is not www',
    'https://acme.greenhouse.io/jobs/4012345',
    'https://boards.greenhouse.io/jobs/4012345',
  ],
  [
    'Workday requisitions',
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Engineer_R-12345',
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Engineer_R-12346',
  ],
  [
    'path case is significant',
    'https://example.com/Careers/Engineer',
    'https://example.com/careers/engineer',
  ],
  [
    'an unrecognised parameter is kept rather than assumed to be noise',
    'https://example.com/careers?jobId=1',
    'https://example.com/careers?jobId=2',
  ],
  // `ref` is how a job reference number would be spelled, and `position` is a
  // synonym for the posting itself. Stripping either collapsed every listing on
  // a board that keys postings that way.
  [
    'ref could be a job reference number',
    'https://example.com/careers?ref=1234',
    'https://example.com/careers?ref=5678',
  ],
  [
    'position could be the posting itself',
    'https://example.com/careers?position=1234',
    'https://example.com/careers?position=5678',
  ],
]

describe('isUsableUrlKey', () => {
  it('accepts a real URL', () => {
    expect(isUsableUrlKey('https://boards.greenhouse.io/acme/jobs/4012345')).toBe(true)
  })

  it('rejects what would key on nothing', () => {
    // These reach storage because `canonicalizeUrl` hands unparseable input back
    // unchanged. Both compare equal to themselves, so without this guard two
    // postings at different employers match on an empty URL.
    expect(isUsableUrlKey('')).toBe(false)
    expect(isUsableUrlKey('n/a')).toBe(false)
    expect(isUsableUrlKey('not a url')).toBe(false)
  })
})

describe('canonicalizeUrl', () => {
  describe('collapses', () => {
    for (const { what, variants } of COLLAPSE) {
      it(what, () => {
        const canonical = variants.map(canonicalizeUrl)
        expect(
          new Set(canonical).size,
          `expected one URL, got ${JSON.stringify(canonical, null, 2)}`,
        ).toBe(1)
      })
    }
  })

  describe('keeps apart', () => {
    for (const [what, left, right] of DISTINCT) {
      it(what, () => {
        expect(canonicalizeUrl(left)).not.toBe(canonicalizeUrl(right))
      })
    }
  })

  it('keeps a fragment that routes and drops one that scrolls', () => {
    expect(canonicalizeUrl('https://acme.com/c#/job/4012345')).toContain('#/job/4012345')
    expect(canonicalizeUrl('https://acme.com/c#job-4012345')).toContain('#job-4012345')
    expect(canonicalizeUrl('https://acme.com/c#apply')).not.toContain('#')
  })

  it('keeps a non-default port, which is part of the address', () => {
    expect(canonicalizeUrl('https://example.com:8443/careers')).toContain(':8443')
    expect(canonicalizeUrl('https://example.com:443/careers')).not.toContain(':443')
  })

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url')
    expect(canonicalizeUrl('  spaced out  ')).toBe('spaced out')
    expect(canonicalizeUrl('')).toBe('')
  })

  it('is idempotent, so re-canonicalizing a stored URL is a no-op', () => {
    for (const { variants } of [...COLLAPSE]) {
      for (const variant of variants) {
        const once = canonicalizeUrl(variant)
        expect(canonicalizeUrl(once)).toBe(once)
      }
    }
  })
})
