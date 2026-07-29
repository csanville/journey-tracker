import { describe, expect, it } from 'vitest'
import manifest from '../manifest.json'

/**
 * Decision 2 as an executable rule.
 *
 * Every host this extension can read is a decision about the install dialog and
 * about what the content script gets to see, and both are easy to widen by
 * accident — a match pattern is a one-character edit away from covering an
 * entire apex domain. This is the one place that notices.
 */
describe('the content script allowlist', () => {
  const patterns = manifest.content_scripts.flatMap((script) => script.matches)

  it('names specific board hosts, never a whole ATS vendor', () => {
    // `https://*.greenhouse.io/*` was the first version, and it covers far more
    // than job boards: `app.greenhouse.io` and `my.greenhouse.io` are the
    // logged-in recruiter console — live hosts, full of candidate data — and
    // `www.` is marketing. The extension would have parsed and snapshotted
    // recruiter pages, cached up to 256KB of them, and offered them in the
    // panel. Company subdomains do not resolve, so the wildcard bought nothing
    // in exchange.
    expect(patterns).toEqual([
      'https://job-boards.greenhouse.io/*',
      'https://boards.greenhouse.io/*',
      'https://jobs.lever.co/*',
    ])
  })

  it('has no wildcard subdomain in any pattern', () => {
    // The property behind the list above, stated so a fourth board added later
    // cannot quietly reintroduce it.
    for (const pattern of patterns) {
      expect(pattern).not.toMatch(/:\/\/\*\./)
    }
  })

  it('asks for no host permissions at all', () => {
    // `content_scripts.matches` grants injection. `host_permissions` grants
    // fetch, cookies and webRequest against those hosts, and this extension
    // does none of them (decision 2).
    expect(manifest).not.toHaveProperty('host_permissions')
    expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'unlimitedStorage'])
  })
})
