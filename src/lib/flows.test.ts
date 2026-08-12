import { describe, expect, it } from 'vitest'
import { isApplicationFlow } from './flows'

/**
 * The URLs here are real, from a live Premera posting and the application flow
 * behind it. That matters more than usual: the requisition pattern this project
 * shipped for Workday was written from invented URLs and did not match a single
 * real one, which is the reason these are copied rather than composed.
 */
const POSTING =
  'https://premera.wd5.myworkdayjobs.com/en-US/Premera/job/Mountlake-Terrace-WA/Software-Development-Engineer-III--React-and-React-Native_R28643-1'

describe('telling an application flow from a posting', () => {
  it('refuses the observed apply URL', () => {
    expect(isApplicationFlow(`${POSTING}/apply/autofillWithResume?source=LinkedIn`)).toBe(
      true,
    )
  })

  it('refuses every step, because they share one URL', () => {
    // `My Information` and `Application Questions` are the same address — the
    // flow is a single-page app that does not touch the bar. One consequence is
    // that this check runs once per flow rather than once per step; the other is
    // that there is no per-step URL to enumerate even if that were wanted.
    const myInformation = `${POSTING}/apply/autofillWithResume?source=LinkedIn`
    const applicationQuestions = `${POSTING}/apply/autofillWithResume?source=LinkedIn`

    expect(myInformation).toBe(applicationQuestions)
    expect(isApplicationFlow(applicationQuestions)).toBe(true)
  })

  it('allows the posting the flow belongs to', () => {
    // The half that fails silently if it goes wrong: over-matching does not
    // break anything visible, it just quietly stops the extension working on
    // pages it should read.
    expect(isApplicationFlow(POSTING)).toBe(false)
  })

  it('allows a posting whose title contains the word', () => {
    const url = `https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Apply-Analytics-Engineer_R28643-1`
    expect(isApplicationFlow(url)).toBe(false)
  })

  it('matches a whole segment, not a substring of one', () => {
    expect(
      isApplicationFlow(
        'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/applying',
      ),
    ).toBe(false)
    expect(isApplicationFlow('https://acme.wd1.myworkdayjobs.com/en-US/apply')).toBe(true)
  })

  it('covers every tenant, which is the reason the wildcard exists', () => {
    for (const host of ['acme.wd1', 'premera.wd5', 'globex.wd103', 'nested.sub.wd3']) {
      expect(
        isApplicationFlow(`https://${host}.myworkdayjobs.com/en-US/X/apply/step`),
      ).toBe(true)
    }
  })

  it('is not fooled by a lookalike host', () => {
    // The same trick `ats.test.ts` guards against: a suffix match rather than a
    // domain match would accept an attacker-controlled host ending in the right
    // letters. Here it would over-refuse rather than over-read, but the habit is
    // the point.
    expect(isApplicationFlow('https://myworkdayjobs.com.evil.example/x/apply/y')).toBe(
      false,
    )
  })

  it('says no to something that is not a URL at all', () => {
    // The safe direction for a guard that refuses reads: an unparseable string
    // is not evidence of an application flow, and the reads this guards are
    // already confined to hosts the manifest names.
    expect(isApplicationFlow('not a url')).toBe(false)
    expect(isApplicationFlow('')).toBe(false)
  })

  /**
   * The scoping decision, asserted rather than left to the shape of a regex.
   *
   * Lever's apply form is `/<company>/<id>/apply`, so a path-only rule would
   * refuse it. Lever has been read since phase 5, has nothing to do with this
   * phase's wildcard, and a refused read costs something real — the panel
   * forgets the posting while the user is applying to it. Extending this to
   * Lever is a decision to take deliberately for Lever, not to inherit from a
   * regex written for Workday.
   */
  it('leaves the boards this phase did not open alone', () => {
    expect(isApplicationFlow('https://jobs.lever.co/acme/1a2b3c4d/apply')).toBe(false)
    expect(isApplicationFlow('https://job-boards.greenhouse.io/acme/jobs/4021')).toBe(false)
    expect(isApplicationFlow('https://jobs.ashbyhq.com/acme/uuid/application')).toBe(false)
  })
})
