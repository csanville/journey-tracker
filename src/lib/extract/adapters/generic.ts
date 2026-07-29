import type { Adapter } from '../types'
import { readJsonLd } from '../tiers/jsonld'
import { readMeta } from '../tiers/meta'

/**
 * The adapter for every site nobody has written an adapter for.
 *
 * This is decision 5's real payoff. A tiered design costs more than a pile of
 * selectors only if the tiers are per-site; the point of putting JSON-LD and
 * OpenGraph at the top is that they are *not* — a board this project has never
 * heard of, on a domain nobody anticipated, still arrives with a title and often
 * a company and a salary, because it wanted to appear in Google Jobs and in a
 * Slack link preview.
 *
 * It carries no DOM tier by definition: a selector is site knowledge, and having
 * none is what this adapter is.
 */
export const generic: Adapter = {
  name: 'generic',
  version: 1,
  matches: () => true,
  readers: [
    { tier: 'jsonld', read: readJsonLd },
    { tier: 'meta', read: readMeta },
  ],
}
