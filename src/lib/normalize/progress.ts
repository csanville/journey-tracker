/**
 * What a record's `stage` and `outcome` are allowed to say together.
 *
 * These are two axes on purpose (see `Stage` in `types.ts`), and two axes admit
 * combinations one enum could not express — which is the point — but also a
 * couple that mean nothing. Those are resolved here, on the way in, for the same
 * reason the join keys are: the worker is the single writer, and a rule applied
 * in the panel as well would eventually be two rules (decision 4).
 *
 * Only two combinations are actually impossible. Everything else is a real
 * situation and is left exactly as the caller sent it — in particular
 * `outcome: 'rejected'` with `stage: null`, which is not a contradiction but the
 * single commonest result in a job search: rejected without ever reaching a
 * screen. Flooring that to a stage would invent a conversation that never
 * happened.
 */
import type { Outcome, PostingState, Stage } from '../types'

/** Weakest first. The order is what makes "furthest reached" comparable. */
export const STAGE_ORDER: readonly Stage[] = ['screening', 'interviewing', 'offer']

/** What `resolveProgress` needs to decide. A `Posting` satisfies it. */
export interface ProgressSource {
  state: PostingState
  stage: Stage | null
  outcome: Outcome | null
}

export interface Progress {
  stage: Stage | null
  outcome: Outcome | null
}

/** True when `stage` has reached `minimum` or gone past it. */
export function stageAtLeast(stage: Stage | null, minimum: Stage): boolean {
  if (stage === null) return false

  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(minimum)
}

/**
 * Whether the employer ever answered.
 *
 * A rejection *is* an answer, which is why this is not simply `stage !== null`.
 * Withdrawing is not — that is the user's own action — so a record withdrawn
 * before anyone replied correctly counts as silence. Where the user withdrew
 * *after* a conversation, `stage` records it and this returns true on that.
 *
 * `accepted` needs no clause of its own: it floors `stage` to `offer` below.
 *
 * Asked as "reached at least the first stage" rather than as `stage !== null`,
 * which is the same question for well-formed data and a safer one for anything
 * else: a record that somehow carries `undefined` — a migration that did not
 * run, a table read by a build that never wrote it — answers false here, where
 * the negative test would answer true and quietly inflate the one rate this
 * exists to report. Wrong low is recoverable; wrong high reads as good news.
 */
export function heardBack(progress: Pick<ProgressSource, 'stage' | 'outcome'>): boolean {
  return stageAtLeast(progress.stage, 'screening') || progress.outcome === 'rejected'
}

/**
 * The stage and outcome actually stored, given what the caller sent.
 *
 * Two rules, both narrow:
 *
 * - **Neither field survives a record that was never applied to.** They describe
 *   what happened *after* an application, and a `viewed` posting has no after.
 *   This is the same rule `toPostingInput` already applies to `appliedAt`, and
 *   it matters most on the path where a user sets a stage and then changes the
 *   status back — without it the record would keep asserting an interview for an
 *   application it no longer claims to have sent.
 * - **An offer is implied by accepting one.** `accepted` with no `offer` stage
 *   is the one genuine contradiction the two axes allow, and flooring it is
 *   cheaper than teaching every reader downstream to special-case it.
 *
 * Idempotent, so it is safe from a migration and safe on a re-save.
 */
export function resolveProgress(source: ProgressSource): Progress {
  if (source.state !== 'applied') return { stage: null, outcome: null }

  const stage =
    source.outcome === 'accepted' && !stageAtLeast(source.stage, 'offer')
      ? 'offer'
      : source.stage

  return { stage, outcome: source.outcome }
}
