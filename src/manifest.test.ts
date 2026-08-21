import { describe, expect, it } from 'vitest'
import manifest from '../manifest.json'
import { isApplicationFlow } from './lib/flows'

/** A real Workday application URL, and the posting it belongs to. */
const WORKDAY_POSTING =
  'https://premera.wd5.myworkdayjobs.com/en-US/Premera/job/Mountlake-Terrace-WA/Software-Development-Engineer-III--React-and-React-Native_R28643-1'
const WORKDAY_APPLY = `${WORKDAY_POSTING}/apply/autofillWithResume?source=LinkedIn`

/**
 * Chrome's match-pattern semantics, enough of them to test with: `*` in the host
 * stands for any leading labels, `*` in the path for any run of characters
 * including `/`.
 */
function matches(pattern: string, rawUrl: string): boolean {
  const parsed = /^([^:]+):\/\/([^/]+)(\/.*)$/.exec(pattern)
  if (!parsed) throw new Error(`not a match pattern: ${pattern}`)

  const [, scheme, host, path] = parsed as unknown as [string, string, string, string]
  const url = new URL(rawUrl)

  if (`${scheme}:` !== url.protocol) return false

  const hostOk = host.startsWith('*.')
    ? url.hostname === host.slice(2) || url.hostname.endsWith(`.${host.slice(2)}`)
    : host === url.hostname

  const pathRe = new RegExp(
    `^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
  )

  return hostOk && pathRe.test(url.pathname + url.search)
}

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
  const excluded = manifest.content_scripts.flatMap(
    (script) => (script as { exclude_matches?: string[] }).exclude_matches ?? [],
  )

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
      // Ashby's board host, and only it. `app.ashbyhq.com` is the recruiter
      // console — the same reason the Greenhouse wildcard came out above.
      'https://jobs.ashbyhq.com/*',
      // The one wildcard, and the amendment to decision 2 that allows it: on
      // Workday the tenant *is* the subdomain, so an allowlist would have to
      // enumerate employers. What it buys is every tenant; what Greenhouse's
      // bought was the recruiter console. See the exclusions below, which are
      // the condition of it.
      'https://*.myworkdayjobs.com/*',
    ])
  })

  /**
   * The rule that replaced "no wildcard subdomain, ever".
   *
   * The ban was the right shape while every board sat on a fixed host, and it
   * caught this phase's first attempt at a Workday match. What it could not
   * express is the thing actually worth defending — not that a wildcard is
   * forbidden, but that a wildcard must say what it is *not* reaching.
   */
  it('lets a wildcard host in only with exclusions naming it', () => {
    for (const pattern of patterns) {
      if (!/:\/\/\*\./.test(pattern)) continue

      const host = /:\/\/\*\.([^/]+)/.exec(pattern)?.[1]
      expect(host).toBeDefined()
      expect(excluded.some((e) => e.includes(host!))).toBe(true)
    }
  })

  /**
   * The two mechanisms, asserted to agree about one real URL.
   *
   * They are separately necessary and neither is sufficient, which is exactly
   * the arrangement that rots: `exclude_matches` stops a cold load into an apply
   * URL and cannot stop the ordinary route, which is a same-document navigation
   * from the posting with the script already running. `isApplicationFlow` stops
   * that one. Two rules about the same pages, in two languages, in two files —
   * so this asserts they say the same thing rather than trusting that whoever
   * edits one remembers the other.
   */
  it('excludes the application flow in the manifest and at runtime alike', () => {
    expect(excluded.some((pattern) => matches(pattern, WORKDAY_APPLY))).toBe(true)
    expect(isApplicationFlow(WORKDAY_APPLY)).toBe(true)

    // And agree about the posting, which is the half that fails silently: an
    // over-broad exclusion does not break anything visible, it just stops the
    // extension working on the pages it was widened to reach.
    expect(excluded.some((pattern) => matches(pattern, WORKDAY_POSTING))).toBe(false)
    expect(isApplicationFlow(WORKDAY_POSTING)).toBe(false)
    expect(patterns.some((pattern) => matches(pattern, WORKDAY_POSTING))).toBe(true)
  })

  /**
   * iCIMS, asserted by its absence.
   *
   * The obvious edit — a fifth board gets a fifth match pattern — is not
   * available here, and the reason is worth an executable note rather than a
   * comment nobody reads. Chrome's host wildcard "must be the first or only
   * character, and it must be followed by a period or forward slash", so
   * `careers-*.icims.com`, which would have named the career portals and only
   * them, is not a legal pattern. The one legal pattern is `*.icims.com`, and on
   * iCIMS that reaches more than a board: the recruiter console is served from
   * the same hosts as the applicant portal under `/icims2/servlet/…`, and the
   * internal employee boards are `internal-<tenant>.icims.com`, which no
   * exclusion can name for the same wildcard reason.
   *
   * A path-constrained `*.icims.com/jobs/*` would keep the script off the
   * console, and it would still put the vendor's whole apex in the install
   * prompt — the warning reads hosts and ignores paths — to reach a board the
   * capture gesture already reaches. So iCIMS is the long tail decision 2
   * describes, and `frames.ts` is what makes the gesture work on it.
   */
  it('names no iCIMS host, and the adapter does not imply one', () => {
    expect(patterns.some((pattern) => pattern.includes('icims'))).toBe(false)
    expect(excluded.some((pattern) => pattern.includes('icims'))).toBe(false)
  })

  it('asks for no host permissions at all', () => {
    // `content_scripts.matches` grants injection. `host_permissions` grants
    // fetch, cookies and webRequest against those hosts, and this extension
    // does none of them (decision 2).
    expect(manifest).not.toHaveProperty('host_permissions')
    expect(manifest.permissions).toEqual([
      'sidePanel',
      'storage',
      'unlimitedStorage',
      // Phase 5's capture gesture. `activeTab` is one tab at a time, granted by
      // the user and lapsing on navigation, which is why it is not the same
      // request as a host permission however similar it sounds.
      'activeTab',
      'scripting',
      'contextMenus',
    ])
  })

  it('offers the capture gesture somewhere that actually grants activeTab', () => {
    // The load-bearing fact of the whole feature: `activeTab` comes from an
    // action, a context menu item, a `commands` shortcut or the omnibox, and
    // from nothing else. A button in the side panel grants nothing, and the
    // action is spoken for by `openPanelOnActionClick`. If both of these
    // disappeared, the feature would still look present and would never once
    // be permitted to read a page.
    expect(manifest.permissions).toContain('contextMenus')
    expect(manifest.commands).toHaveProperty('capture-page')
  })
})
