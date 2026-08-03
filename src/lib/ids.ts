/**
 * Identity and time, isolated so tests can hold both still.
 */

/**
 * Stable record identity — see the note on `PostingInput.id`.
 *
 * `crypto.randomUUID` is only exposed in a secure context, and until phase 5
 * every context this ran in was one: the panel and the worker are extension
 * pages, and the declared content script only runs on three `https://` boards.
 * `activeTab` capture removed that guarantee — the injected bundle is aimed at
 * whatever page the user right-clicked, and plenty of small-company careers
 * pages are still served over plain `http://`. There, `randomUUID` is simply
 * absent, the detection threw before it could be sent, the ladder swallowed it
 * as an ordinary failed rung, and the panel opened saying nothing was found on
 * a page it had parsed perfectly well.
 *
 * `getRandomValues` carries no such restriction, so the fallback is as random as
 * the fast path. It is written out rather than reached for first because
 * `randomUUID` exists precisely to avoid hand-rolling this, and hand-rolled is
 * what the reserved bits below make it.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))

  // Version 4, variant 1 — the two fields a v4 UUID is required to pin.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Epoch milliseconds. Wrapped so tests can stub it in one place. */
export function now(): number {
  return Date.now()
}
