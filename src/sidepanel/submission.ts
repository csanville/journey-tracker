/**
 * Turning a confirmed submission into the write the user is being offered.
 *
 * Outside React for the usual reason: what a prompt *does* to a record is worth
 * testing, and it is awkward to test through a banner with two buttons.
 *
 * Nothing here runs on its own. The worker only ever announces that a
 * confirmation page matched a stored record (decision 12: detection prompts,
 * it does not write), so this is reached exactly once, from a click.
 */
import { POSTING_INPUT_FIELDS } from '../lib/types'
import type { Posting, PostingInput } from '../lib/types'

/**
 * The record as it would be after the user confirms they applied.
 *
 * Projected through `POSTING_INPUT_FIELDS` rather than spread wholesale,
 * because a `Posting` also carries `schemaVersion` and `updatedAt` — fields the
 * repository owns, which a caller has no business sending back (decision 4).
 * The list already exists to say which fields a caller controls, so using it
 * here means a field added later joins this path by existing rather than by
 * somebody remembering.
 *
 * `createdAt` is deliberately not sent. `upsertPosting` finds the stored record
 * by id and keeps its own, which is what stops a confirmation from re-dating a
 * posting saved weeks ago.
 *
 * An `appliedAt` already on the record wins over `when`. That case only arises
 * for a record whose status was moved back to `viewed` after a date was
 * recorded — the repository nulls the date on that transition, so in practice
 * `when` is what lands — but where a date does survive, the user typed it and
 * this has no business overwriting it with today.
 */
export function markApplied(posting: Posting, when: number): PostingInput {
  const carried = Object.fromEntries(
    POSTING_INPUT_FIELDS.map((field) => [field, posting[field]]),
  ) as Omit<PostingInput, 'id'>

  return {
    ...carried,
    id: posting.id,
    state: 'applied',
    appliedAt: posting.appliedAt ?? when,
  }
}
