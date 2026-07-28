/**
 * Identity and time, isolated so tests can hold both still.
 */

/** Stable record identity — see the note on `PostingInput.id`. */
export function newId(): string {
  return crypto.randomUUID()
}

/** Epoch milliseconds. Wrapped so tests can stub it in one place. */
export function now(): number {
  return Date.now()
}
