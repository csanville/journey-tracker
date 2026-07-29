/**
 * Reading a board's own client-side state out of its inline scripts.
 *
 * **Why this reads script *text* rather than a global.** Greenhouse hands its
 * job post to the page as `window.__remixContext`, and the obvious way to get
 * it is to read `window.__remixContext`. A content script cannot: it runs in an
 * isolated world with its own JavaScript heap, sharing the DOM with the page but
 * nothing else. Its `window` is not the page's `window`, so the property is
 * simply not there.
 *
 * The DOM *is* shared, and the state arrives inside a `<script>` element, so
 * the text of that element is readable. Parsing the text is therefore not a
 * workaround for a missing API — it is the only path that exists short of a
 * `world: "MAIN"` injection, which would put extension code in the page's own
 * context and is a much larger ask for what a regex already gets.
 *
 * The same isolation is why `../../content/watch-url.ts` cannot patch
 * `history.pushState` the way the roadmap suggested.
 */

/** Beyond this a script is a bundle, not a state blob, and is not worth scanning. */
const MAX_SCRIPT_LENGTH = 2_000_000

/**
 * The first inline script whose text matches one of `assignments`, as JSON.
 *
 * Each pattern must have exactly one capture group holding the JSON literal.
 * Several are accepted because a regex cannot balance braces: a greedy
 * `(\{[\s\S]*\})` swallows any trailing code after the object, and a lazy one
 * stops at the first nested `}`. Callers pass both and let whichever parses
 * win, which is cheaper and far more readable than hand-writing a brace scanner
 * that also has to respect string literals and escapes.
 *
 * Returns `null` when nothing matches or nothing parses. A board changing its
 * bundler is an ordinary event, and an exception here would take the whole
 * extraction down over a tier that is meant to be optional.
 */
export function readScriptJson(
  document: Document,
  assignments: readonly RegExp[],
): unknown | null {
  for (const script of document.querySelectorAll('script:not([src])')) {
    const text = script.textContent
    if (!text || text.length > MAX_SCRIPT_LENGTH) continue

    for (const assignment of assignments) {
      const match = assignment.exec(text)
      if (!match?.[1]) continue

      try {
        return JSON.parse(match[1])
      } catch {
        // Matched the assignment but not a complete JSON literal. Try the next
        // pattern rather than claiming the page said nothing.
      }
    }
  }

  return null
}

/** Walks a dotted path, returning `undefined` rather than throwing on a gap. */
export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value

  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string | number, unknown>)[key]
  }

  return current
}
