/**
 * Reading text out of a page, and the guards every reader needs.
 *
 * All of this is small, but none of it is optional. A job board's markup is
 * hostile input in the ordinary sense — not malicious, just arbitrary — and an
 * adapter that hands `"\n        Senior Engineer\n      "` or a 40KB blob to
 * the form has technically extracted something and practically produced a mess.
 */

/** Longer than any real company or job title, short enough to bound the form. */
const MAX_FIELD_LENGTH = 300

/**
 * Collapses whitespace and drops anything that is not usable as a field value.
 *
 * Returns `null` rather than an empty string so callers can use `??` chaining
 * and so "found nothing" and "found blank" stop being different states — an
 * empty company is the same absence as a missing one, and the join keys treat
 * them identically.
 *
 * Over-long values are rejected outright instead of truncated. A field that
 * long is a selector that matched a container rather than a label, and half of
 * a wrong answer is still a wrong answer — it would just be harder to spot in
 * the form.
 */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null

  // ` ` is the one whitespace character `\s` in a `.trim()` handles but
  // that survives inside a string, and boards emit it constantly.
  const collapsed = value.replace(/[\s ]+/g, ' ').trim()

  if (!collapsed || collapsed.length > MAX_FIELD_LENGTH) return null

  return collapsed
}

/**
 * The text of the first element matching any selector, in order.
 *
 * `textContent` rather than `innerText` on purpose: `innerText` is defined in
 * terms of layout, so it is empty in a test DOM and would make every DOM-tier
 * test vacuous while passing in a browser — the exact failure mode that is
 * invisible until someone loads the extension.
 */
export function firstText(root: ParentNode, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const element = root.querySelector(selector)
    const text = cleanText(element?.textContent)
    if (text) return text
  }

  return null
}

/** The first present, non-empty attribute value among the given selectors. */
export function firstAttr(
  root: ParentNode,
  selectors: readonly string[],
  attribute: string,
): string | null {
  for (const selector of selectors) {
    const value = cleanText(root.querySelector(selector)?.getAttribute(attribute))
    if (value) return value
  }

  return null
}

/**
 * Splits a page title on a separator, when it holds exactly two parts.
 *
 * Both launch boards encode company and title in `<title>`, in opposite orders
 * (`"Company - Title"` on Lever, `"Job Application for Title at Company"` on
 * Greenhouse), so the split itself is shared and the interpretation is not.
 *
 * Exactly two parts is the whole guard. `"Acme - Senior Engineer - Remote"`
 * splits three ways and there is no way to tell which piece is the employer, so
 * nothing is returned rather than a guess. Same reasoning as the ATS matchers:
 * a missed field costs typing, a wrong one corrupts a join key.
 */
export function splitOnce(
  title: string | null,
  separator: RegExp,
): [string, string] | null {
  const text = cleanText(title)
  if (!text) return null

  const parts = text.split(separator).map((part) => cleanText(part))
  if (parts.length !== 2) return null

  const [left, right] = parts

  return left && right ? [left, right] : null
}
