import { describe, expect, it } from 'vitest'
import { confirmationTarget } from './confirmation'

/**
 * The URL shapes here are real. The matching cases are the pattern behind live
 * confirmation pages found indexed on several boards; the rejections are the
 * near misses that would each cost a prompt about a job nobody applied to.
 */
describe('confirmationTarget', () => {
  it('reads the posting out of a confirmation URL', () => {
    expect(
      confirmationTarget(
        'https://job-boards.greenhouse.io/usaforunhcr/jobs/4941879008/confirmation',
      ),
    ).toBe('https://job-boards.greenhouse.io/usaforunhcr/jobs/4941879008')
  })

  it('reads the older board host too, since the manifest declares both', () => {
    expect(
      confirmationTarget('https://boards.greenhouse.io/initech/jobs/4021/confirmation'),
    ).toBe('https://boards.greenhouse.io/initech/jobs/4021')
  })

  it('drops the query string, which describes the confirmation and not the job', () => {
    expect(
      confirmationTarget(
        'https://job-boards.greenhouse.io/initech/jobs/4021/confirmation?gh_src=abc123',
      ),
    ).toBe('https://job-boards.greenhouse.io/initech/jobs/4021')
  })

  it('tolerates a trailing slash', () => {
    expect(
      confirmationTarget(
        'https://job-boards.greenhouse.io/initech/jobs/4021/confirmation/',
      ),
    ).toBe('https://job-boards.greenhouse.io/initech/jobs/4021')
  })

  describe('declines', () => {
    /**
     * The important half. Every one of these would fire a prompt saying
     * somebody applied to a job they did not, which decision 12 names as the
     * thing that corrodes trust in a tracker.
     */
    const REJECTED: Array<[what: string, url: string]> = [
      ['the posting itself', 'https://job-boards.greenhouse.io/initech/jobs/4021'],
      [
        'the application form',
        'https://job-boards.greenhouse.io/initech/jobs/4021/application',
      ],
      ['the board index', 'https://job-boards.greenhouse.io/initech'],
      [
        'a deeper path that merely ends in the word',
        'https://job-boards.greenhouse.io/initech/jobs/4021/x/confirmation',
      ],
      [
        'a posting whose id is not a number',
        'https://job-boards.greenhouse.io/initech/jobs/confirmation/confirmation',
      ],
      [
        'the recruiter console, which is a different product on the same apex',
        'https://app.greenhouse.io/initech/jobs/4021/confirmation',
      ],
      [
        'a lookalike host',
        'https://job-boards.greenhouse.io.evil.test/initech/jobs/4021/confirmation',
      ],
      ['another board entirely', 'https://jobs.lever.co/initech/4021/confirmation'],
      [
        'plain http, which these boards do not serve',
        'http://job-boards.greenhouse.io/initech/jobs/4021/confirmation',
      ],
      ['something that is not a URL', 'not a url'],
      ['an empty string', ''],
    ]

    for (const [what, url] of REJECTED) {
      it(what, () => {
        expect(confirmationTarget(url)).toBeNull()
      })
    }
  })

  /**
   * Lever's success page is an employer-configurable redirect, so there is no
   * shape to match. This pins the *absence* deliberately: a later change that
   * adds a guessed Lever pattern should have to delete this test and argue with
   * the reason written next to it.
   */
  it('claims nothing about Lever, whose success URL the employer chooses', () => {
    expect(confirmationTarget('https://jobs.lever.co/leverdemo/004f960b/thanks')).toBeNull()
    expect(confirmationTarget('https://jobs.lever.co/leverdemo/004f960b/apply')).toBeNull()
  })
})
