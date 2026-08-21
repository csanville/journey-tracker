import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Fixture loading for the adapter tests.
 *
 * Only usable from a file carrying `@vitest-environment jsdom`. The suite runs
 * in `node` by default and stays that way: a DOM costs setup time on every one
 * of the two hundred tests that do not need one, and the extraction tests are
 * the only ones that do.
 */
export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/**
 * Resolved from the working directory rather than `import.meta.url`, which
 * under the jsdom environment is rewritten against the fake document's own
 * base URL and lands at the filesystem root. Vitest always runs from the
 * project root, so this is both simpler and the one that works.
 */
export function loadFixture(name: string): Document {
  return parseHtml(loadRawFixture(name))
}

/**
 * The same file as text, for a test that has to take something *out* of a
 * capture before parsing it.
 *
 * Editing markup as a string is worse than editing a DOM in every way but the
 * one that matters here: removing a whole tier — every JSON-LD block, say — and
 * then parsing what is left is a document a real tenant could serve, where a
 * DOM with the nodes detached is a document this project imagined.
 */
export function loadRawFixture(name: string): string {
  return readFileSync(resolve('src/test/fixtures', name), 'utf8')
}
