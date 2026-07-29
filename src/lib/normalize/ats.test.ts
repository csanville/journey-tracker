import { describe, expect, it } from 'vitest'
import { extractAtsReqId, identifyAts, type AtsName } from './ats'

const CASES: Array<[what: string, url: string, ats: AtsName, reqId: string]> = [
  [
    'a Greenhouse board',
    'https://boards.greenhouse.io/acme/jobs/4012345',
    'greenhouse',
    '4012345',
  ],
  [
    'a Greenhouse company subdomain',
    'https://acme.greenhouse.io/jobs/4012345',
    'greenhouse',
    '4012345',
  ],
  [
    'a Greenhouse application page',
    'https://boards.greenhouse.io/acme/jobs/4012345#app',
    'greenhouse',
    '4012345',
  ],
  [
    'a Greenhouse board embedded on the company site',
    'https://acme.com/careers?gh_jid=4012345&gh_src=abc',
    'greenhouse',
    '4012345',
  ],
  [
    'a Lever posting',
    'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456',
    'lever',
    '0f0e2b1a-1234-4c8d-9e0f-abcdef123456',
  ],
  [
    'a Lever apply page, where the id is not the last segment',
    'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456/apply',
    'lever',
    '0f0e2b1a-1234-4c8d-9e0f-abcdef123456',
  ],
  [
    'an Ashby posting',
    'https://jobs.ashbyhq.com/acme/1a2b3c4d-5678-4c8d-9e0f-abcdef123456',
    'ashby',
    '1a2b3c4d-5678-4c8d-9e0f-abcdef123456',
  ],
  [
    'an embedded Ashby board',
    'https://acme.com/careers?ashby_jid=1a2b3c4d-5678-4c8d-9e0f-abcdef123456',
    'ashby',
    '1a2b3c4d-5678-4c8d-9e0f-abcdef123456',
  ],
  [
    'a Workday requisition',
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/San-Francisco/Software-Engineer_R-12345',
    'workday',
    'R-12345',
  ],
  [
    'a Workday requisition with a longer prefix',
    'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Staff-Engineer_JR-987654',
    'workday',
    'JR-987654',
  ],
  [
    'a Workday requisition with no hyphen',
    'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/NYC/Analyst_REQ12345',
    'workday',
    'REQ12345',
  ],
]

/**
 * Shapes that must yield nothing. A wrong id is worse than no id — it is what
 * would join two unrelated applications through the fallback dedupe key.
 */
const NO_MATCH: Array<[what: string, url: string]> = [
  ['a Greenhouse board index with no job', 'https://boards.greenhouse.io/acme'],
  [
    'a Workday board with no job in the path',
    'https://acme.wd1.myworkdayjobs.com/en-US/External',
  ],
  [
    'a Workday title containing an underscore but no requisition',
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Software_Engineer',
  ],
  ['a Lever board index', 'https://jobs.lever.co/acme'],
  [
    'a Greenhouse job id that is not numeric',
    'https://boards.greenhouse.io/acme/jobs/engineer',
  ],
  ['a lookalike host', 'https://greenhouse.io.evil.example/acme/jobs/4012345'],
  ['a gh_jid that is not numeric', 'https://acme.com/careers?gh_jid=abc'],
  ['an ashby_jid that is not a uuid', 'https://acme.com/careers?ashby_jid=12345'],
  ['a company careers page', 'https://acme.com/careers/software-engineer'],
  // The last underscore-separated chunk of a Workday title is not a
  // requisition just because it is numeric. Two internships at one employer
  // both yielding "2026" is a wrong merge, not a missed one.
  [
    'a Workday title ending in a year',
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Software-Engineer-Intern_Summer_2026',
  ],
  [
    'a Workday title ending in a bare number',
    'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Engineer_Level_3000',
  ],
  ['an unparseable string', 'not a url'],
  ['an empty string', ''],
]

describe('identifyAts', () => {
  for (const [what, url, ats, reqId] of CASES) {
    it(`reads ${what}`, () => {
      expect(identifyAts(url)).toEqual({ ats, reqId })
    })
  }

  describe('returns null for', () => {
    for (const [what, url] of NO_MATCH) {
      it(what, () => {
        expect(identifyAts(url)).toBeNull()
      })
    }
  })

  it('lets a definitive host outrank a stray embedded parameter', () => {
    // A `gh_jid` can appear on any page; a Lever hostname means a Lever posting.
    // Checked first, the parameter produced a Greenhouse id for a Lever job.
    expect(
      identifyAts(
        'https://jobs.lever.co/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456?gh_jid=99',
      ),
    ).toEqual({ ats: 'lever', reqId: '0f0e2b1a-1234-4c8d-9e0f-abcdef123456' })
  })

  it('folds requisition case, so the same posting matches through either link', () => {
    const upper = 'https://jobs.ashbyhq.com/acme/0F0E2B1A-1234-4C8D-9E0F-ABCDEF123456'
    const lower = 'https://jobs.ashbyhq.com/acme/0f0e2b1a-1234-4c8d-9e0f-abcdef123456'

    // `findDuplicate` compares requisitions with `===`, so an unfolded id is a
    // missed merge on nothing more than link casing.
    expect(identifyAts(upper)).toEqual(identifyAts(lower))

    const workday =
      'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Engineer_r-12345'
    expect(identifyAts(workday)?.reqId).toBe('R-12345')
  })

  it('is unaffected by tracking parameters', () => {
    const clean = 'https://boards.greenhouse.io/acme/jobs/4012345'
    const tracked = `${clean}?utm_source=linkedin&gh_src=abc&gclid=xyz`

    expect(identifyAts(tracked)).toEqual(identifyAts(clean))
  })
})

describe('extractAtsReqId', () => {
  it('returns just the id', () => {
    expect(extractAtsReqId('https://boards.greenhouse.io/acme/jobs/4012345')).toBe(
      '4012345',
    )
  })

  it('returns null for a URL it does not recognise', () => {
    expect(extractAtsReqId('https://acme.com/careers')).toBeNull()
  })
})
