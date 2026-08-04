import { describe, expect, it } from 'vitest'
import type { Outcome, PostingState, Stage } from '../types'
import { heardBack, resolveProgress, STAGE_ORDER, stageAtLeast } from './progress'

function source(
  state: PostingState,
  stage: Stage | null = null,
  outcome: Outcome | null = null,
) {
  return { state, stage, outcome }
}

describe('stageAtLeast', () => {
  it('is false for a stage that was never reached', () => {
    expect(stageAtLeast(null, 'screening')).toBe(false)
  })

  it('is true at the boundary, not merely past it', () => {
    expect(stageAtLeast('screening', 'screening')).toBe(true)
  })

  it('orders the ladder', () => {
    expect(stageAtLeast('offer', 'screening')).toBe(true)
    expect(stageAtLeast('screening', 'offer')).toBe(false)
  })

  it('agrees with the declared order', () => {
    expect(STAGE_ORDER).toEqual(['screening', 'interviewing', 'offer'])
  })
})

describe('heardBack', () => {
  it('is false for an application nobody has answered', () => {
    expect(heardBack({ stage: null, outcome: null })).toBe(false)
  })

  it('counts a rejection, which is an answer', () => {
    expect(heardBack({ stage: null, outcome: 'rejected' })).toBe(true)
  })

  /**
   * The distinction the response rate depends on. Withdrawing is the user's own
   * action, so a record withdrawn before anyone replied is still silence — and
   * counting it as a response would inflate the one number this view exists to
   * report.
   */
  it('does not count withdrawing before anyone replied', () => {
    expect(heardBack({ stage: null, outcome: 'withdrawn' })).toBe(false)
  })

  it('counts withdrawing after a conversation, because the stage records it', () => {
    expect(heardBack({ stage: 'interviewing', outcome: 'withdrawn' })).toBe(true)
  })
})

describe('resolveProgress', () => {
  it('strips both fields from a posting that was only looked at', () => {
    expect(resolveProgress(source('viewed', 'interviewing', 'rejected'))).toEqual({
      stage: null,
      outcome: null,
    })
  })

  /**
   * The path this rule exists for: a stage is set, then the status is put back
   * to `viewed`. Without the strip the record keeps asserting an interview for
   * an application it no longer claims to have sent.
   */
  it('strips them when the status is moved back off applied', () => {
    const applied = resolveProgress(source('applied', 'offer', null))
    expect(applied.stage).toBe('offer')

    expect(resolveProgress(source('viewed', applied.stage, applied.outcome))).toEqual({
      stage: null,
      outcome: null,
    })
  })

  it('floors an accepted offer to the offer stage', () => {
    expect(resolveProgress(source('applied', null, 'accepted'))).toEqual({
      stage: 'offer',
      outcome: 'accepted',
    })
  })

  it('does not walk an accepted offer backwards from a further stage', () => {
    // There is nothing past `offer` today, so this pins the direction of the
    // floor rather than a current behaviour difference: it must raise a stage
    // that is short, never lower one that is not.
    expect(resolveProgress(source('applied', 'offer', 'accepted')).stage).toBe('offer')
  })

  /**
   * The combination that looks like a contradiction and is not. Rejected with
   * no stage is the commonest result in a job search — turned down without ever
   * reaching a screen — and flooring it would invent a conversation.
   */
  it('leaves a rejection with no stage exactly as it is', () => {
    expect(resolveProgress(source('applied', null, 'rejected'))).toEqual({
      stage: null,
      outcome: 'rejected',
    })
  })

  it('leaves a rejection after interviews on the stage it reached', () => {
    expect(resolveProgress(source('applied', 'interviewing', 'rejected'))).toEqual({
      stage: 'interviewing',
      outcome: 'rejected',
    })
  })

  it('is idempotent, which is what makes it safe from a migration', () => {
    for (const input of [
      source('applied', null, 'accepted'),
      source('viewed', 'offer', 'rejected'),
      source('applied', 'screening', null),
    ]) {
      const once = resolveProgress(input)
      expect(resolveProgress({ state: input.state, ...once })).toEqual(once)
    }
  })
})
