// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { loadFixture, parseHtml } from '../../test/dom'
import { extract } from './index'
import { SNAPSHOT_CAP_BYTES, buildSnapshot } from './snapshot'

const GREENHOUSE_URL = 'https://job-boards.greenhouse.io/discord/jobs/8433948002'
const LEVER_URL = 'https://jobs.lever.co/leverdemo/004f960b-c8be-4e98-8d37-b3be47f99ea0'

describe('buildSnapshot', () => {
  it('produces a document the adapters can parse again', () => {
    // The property the whole of decision 6 rests on. A snapshot that cannot be
    // re-parsed is not a snapshot, it is a souvenir — and the failure would only
    // show up months later, when someone tried to replay a parser fix.
    for (const [name, url] of [
      ['greenhouse-job.html', GREENHOUSE_URL],
      ['lever-job.html', LEVER_URL],
    ] as const) {
      const live = loadFixture(name)
      const { trimmedSource } = buildSnapshot(live)

      expect(extract(parseHtml(trimmedSource), url).fields).toEqual(
        extract(live, url).fields,
      )
    }
  })

  it('keeps the class names the DOM tier selects on', () => {
    const { trimmedSource } = buildSnapshot(loadFixture('greenhouse-job.html'))

    expect(trimmedSource).toContain('job__title')
    expect(trimmedSource).toContain('job__location')
  })

  it('keeps every JSON-LD block verbatim', () => {
    const { trimmedSource } = buildSnapshot(loadFixture('lever-job.html'))

    expect(trimmedSource).toContain('application/ld+json')
    expect(trimmedSource).toContain('Lever Demo 2')
  })

  it('drops the application form and everything the user would type into it', () => {
    // The PII half of decision 6, and not a hypothetical: the real Greenhouse
    // page carries a voluntary self-identification questionnaire, prefilled on
    // a logged-in session.
    const document = parseHtml(
      `<html><head><title>Job Application for Engineer at Initech</title></head>
       <body><main>
         <h1 class="job__title">Engineer</h1>
         <form><input name="email" value="someone@example.com">
           <select name="gender"><option>Prefer not to say</option></select>
           <textarea name="cover">Dear hiring manager</textarea>
         </form>
       </main></body></html>`,
    )

    const { trimmedSource } = buildSnapshot(document)

    expect(trimmedSource).toContain('Engineer')
    expect(trimmedSource).not.toContain('someone@example.com')
    expect(trimmedSource).not.toContain('Dear hiring manager')
    expect(trimmedSource).not.toContain('Prefer not to say')
    expect(trimmedSource).not.toContain('<form')
  })

  it('drops the state blob in the head, which is where Greenhouse puts it', () => {
    // That blob is the best tier this project has, and it also holds the
    // questionnaire. Keeping it is not an option; the cost is that a re-parsed
    // Greenhouse snapshot falls back to the DOM tier, which the round-trip test
    // above shows loses nothing that matters.
    const { trimmedSource } = buildSnapshot(loadFixture('greenhouse-job.html'))

    expect(trimmedSource).not.toContain('__remixContext')
  })

  it('drops an inline script sitting inside the posting itself', () => {
    // Not the same test as the one above, which passes for the wrong reason:
    // the head is filtered by an allowlist, so a script there is excluded
    // whatever the element rules say. Analytics and consent scripts live in the
    // body, inside the subtree that is kept, and only `DROP_ELEMENTS` removes
    // those.
    const document = parseHtml(
      `<html><body><main>
         <h1 class="job__title">Engineer</h1>
         <script>window.dataLayer.push({ email: 'someone@example.com' })</script>
       </main></body></html>`,
    )

    const { trimmedSource } = buildSnapshot(document)

    expect(trimmedSource).toContain('Engineer')
    expect(trimmedSource).not.toContain('dataLayer')
    expect(trimmedSource).not.toContain('someone@example.com')
  })

  it('strips presentation and behaviour attributes', () => {
    const document = parseHtml(
      `<html><body><main class="keep" style="color:red" onclick="track()">
         <p class="job__title">Engineer</p></main></body></html>`,
    )

    const { trimmedSource } = buildSnapshot(document)

    expect(trimmedSource).toContain('class="keep"')
    expect(trimmedSource).not.toContain('style=')
    expect(trimmedSource).not.toContain('onclick')
  })

  it('truncates rather than dropping a snapshot that exceeds the cap', () => {
    const filler = '<p>x</p>'.repeat(60_000)
    const document = parseHtml(
      `<html><head><title>Job Application for Engineer at Initech</title></head>
       <body><main><h1 class="job__title">Engineer</h1>${filler}</main></body></html>`,
    )

    const snapshot = buildSnapshot(document)

    expect(snapshot.truncated).toBe(true)
    expect(new TextEncoder().encode(snapshot.trimmedSource).length).toBeLessThanOrEqual(
      SNAPSHOT_CAP_BYTES,
    )
    // Decision 6 is explicit that a cut capture beats no capture, and what a
    // re-parse needs is near the top of the posting.
    expect(snapshot.trimmedSource).toContain('Job Application for Engineer at Initech')
    expect(snapshot.trimmedSource).toContain('truncated at the snapshot size cap')
  })

  it('stays under the cap when the overflow is multi-byte', () => {
    // Slicing a byte budget by characters is safe; the loop that follows is for
    // the case where it was not conservative enough.
    const filler = '<p>—————————</p>'.repeat(30_000)
    const document = parseHtml(`<html><body><main>${filler}</main></body></html>`)

    const snapshot = buildSnapshot(document)

    expect(new TextEncoder().encode(snapshot.trimmedSource).length).toBeLessThanOrEqual(
      SNAPSHOT_CAP_BYTES,
    )
  })

  it('still stores something when the head alone busts the cap', () => {
    // Every JSON-LD block is kept verbatim, so a board that inlines its whole
    // listing can push the head past 256KB on its own. Cutting the body then
    // reaches zero with the document still over, and the returned snapshot
    // *exceeded* the cap — which `sanitizeReport` discards outright, leaving no
    // snapshot and no marker to explain why. Decision 6 says a cut capture
    // beats none.
    const filler = JSON.stringify({
      '@type': 'JobPosting',
      title: 'Engineer',
      description: 'x'.repeat(400 * 1024),
    })
    const document = parseHtml(
      `<html><head><title>Job Application for Engineer at Initech</title>
       <script type="application/ld+json">${filler}</script></head>
       <body><main><p>body</p></main></body></html>`,
    )

    const snapshot = buildSnapshot(document)

    expect(snapshot.truncated).toBe(true)
    expect(new TextEncoder().encode(snapshot.trimmedSource).length).toBeLessThanOrEqual(
      SNAPSHOT_CAP_BYTES,
    )
    expect(snapshot.trimmedSource).not.toBe('')
    // The front of the head survives, which is where `<title>` sits.
    expect(snapshot.trimmedSource).toContain('Job Application for Engineer at Initech')
  })

  it('does not mark a snapshot inside the cap as truncated', () => {
    const snapshot = buildSnapshot(loadFixture('lever-job.html'))

    expect(snapshot.truncated).toBe(false)
    expect(snapshot.trimmedSource).not.toContain('truncated at the snapshot size cap')
  })
})
