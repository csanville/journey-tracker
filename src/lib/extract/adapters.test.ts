// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { loadFixture, parseHtml } from '../../test/dom'
import { extract, selectAdapter } from './index'
import { ashbyReaders } from './adapters/ashby'
import { greenhouseReaders } from './adapters/greenhouse'
import { leverReaders } from './adapters/lever'
import { workday } from './adapters/workday'
import { readJsonLd } from './tiers/jsonld'
import { readMeta } from './tiers/meta'

/**
 * The fixtures are real captures, trimmed — see the comment at the top of each.
 * That matters: the point of checking in HTML is that a board changing its
 * markup shows up as a failing test rather than as silence, and markup this
 * project invented could never do that.
 *
 * What these tests cannot do is notice that the *live* board has changed since
 * the capture. Only loading a real posting in Chrome does that, which is why
 * that check is part of signing the phase off rather than something the suite
 * claims to cover.
 */

const GREENHOUSE_URL = 'https://job-boards.greenhouse.io/discord/jobs/8433948002'
const LEVER_URL = 'https://jobs.lever.co/leverdemo/004f960b-c8be-4e98-8d37-b3be47f99ea0'
const ASHBY_URL = 'https://jobs.ashbyhq.com/ramp/d1183b00-6590-4fe4-a585-28d84e578fe3'
const WORKDAY_URL =
  'https://premera.wd5.myworkdayjobs.com/en-US/Premera/job/Mountlake-Terrace-WA/Software-Development-Engineer-III--React-and-React-Native_R28643-1'

describe('selectAdapter', () => {
  it('routes each board to its own adapter', () => {
    expect(selectAdapter(GREENHOUSE_URL).name).toBe('greenhouse')
    expect(selectAdapter('https://boards.greenhouse.io/acme/jobs/1').name).toBe(
      'greenhouse',
    )
    expect(selectAdapter(LEVER_URL).name).toBe('lever')
    expect(selectAdapter(ASHBY_URL).name).toBe('ashby')
  })

  it('falls back to the generic adapter for everything else', () => {
    expect(selectAdapter('https://careers.acme.example/jobs/12').name).toBe('generic')
    // Including a string that is not a URL at all, which is what a content
    // script on a `file://` page or an `about:` page would report.
    expect(selectAdapter('not a url').name).toBe('generic')
  })

  it('is not fooled by a hostname that merely ends in the board’s name', () => {
    expect(selectAdapter('https://notgreenhouse.io/jobs/1').name).toBe('generic')
    expect(selectAdapter('https://lever.co.evil.example/x').name).toBe('generic')
    expect(selectAdapter('https://notashbyhq.com/acme/1').name).toBe('generic')
    expect(selectAdapter('https://ashbyhq.com.evil.example/x').name).toBe('generic')
  })
})

describe('greenhouse', () => {
  const document = loadFixture('greenhouse-job.html')

  it('reads the posting from the page’s own state blob', () => {
    // The blob is reached by parsing the *text* of the script element. A content
    // script runs in an isolated world and cannot see `window.__remixContext`,
    // so a reader that touched the global would find nothing in a browser while
    // passing every test here.
    expect(greenhouseReaders.readAppState(document)).toMatchObject({
      company: 'Discord',
      jobTitle: 'Account Executive - Tech',
    })
  })

  it('finds the state blob by shape, not by Greenhouse’s route filename', () => {
    const renamed = parseHtml(
      `<html><head><script>window.__remixContext = ${JSON.stringify({
        state: {
          loaderData: {
            'routes/whatever-they-rename-it-to': {
              jobPost: { title: 'Staff Engineer', company_name: 'Initech' },
            },
          },
        },
      })};</script></head><body></body></html>`,
    )

    expect(greenhouseReaders.readAppState(renamed)).toMatchObject({
      company: 'Initech',
      jobTitle: 'Staff Engineer',
    })
  })

  it('reads title, location and employer from the DOM alone', () => {
    // The employer appears nowhere in the body — only in `<title>`, phrased
    // "Job Application for {title} at {company}".
    expect(greenhouseReaders.readDom(document)).toMatchObject({
      company: 'Discord',
      jobTitle: 'Account Executive - Tech',
      location: 'San Francisco Bay Area or New York (Remote (U.S.))',
      workMode: 'remote',
    })
  })

  it('takes the last " at " when the role itself contains one', () => {
    const document = parseHtml(
      '<html><head><title>Job Application for Engineer at Scale at Initech</title></head><body></body></html>',
    )

    expect(greenhouseReaders.readDom(document).company).toBe('Initech')
  })

  it('has no JSON-LD to read, which is the point', () => {
    // Decision 5 ranks JSON-LD first on the argument that boards emit it for
    // Google Jobs indexing. Greenhouse does not, and the capture proves it.
    expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(0)
    expect(readJsonLd(document)).toEqual({})
  })

  it('extracts the whole record, crediting the strongest tier that answered', () => {
    const result = extract(document, GREENHOUSE_URL)

    expect(result.source).toBe('greenhouse')
    expect(result.adapterVersion).toBe('greenhouse@1')
    expect(result.fields).toMatchObject({
      company: 'Discord',
      jobTitle: 'Account Executive - Tech',
      location: 'San Francisco Bay Area or New York (Remote (U.S.))',
      workMode: 'remote',
    })
    expect(result.provenance.company).toBe('appstate')
    expect(result.provenance.location).toBe('appstate')
  })

  it('falls back to the DOM for everything when the state blob is gone', () => {
    // A Greenhouse bundler change is what this looks like, and it must cost the
    // appstate tier rather than the extraction.
    const withoutState = parseHtml(
      document.documentElement.outerHTML.replace(/<script>[\s\S]*?<\/script>/, ''),
    )

    const result = extract(withoutState, GREENHOUSE_URL)

    expect(result.fields).toMatchObject({
      company: 'Discord',
      jobTitle: 'Account Executive - Tech',
      location: 'San Francisco Bay Area or New York (Remote (U.S.))',
    })
    expect(result.provenance.company).toBe('dom')
  })

  it('reads the location out of the state blob, not only the DOM', () => {
    expect(greenhouseReaders.readAppState(document).location).toBe(
      'San Francisco Bay Area or New York (Remote (U.S.))',
    )
  })

  it('never writes a requisition id, however many ids the page offers', () => {
    // The blob carries `hiring_plan_id`, 6368940002, one key away from the
    // title. The posting is 8433948002. A hiring plan also spans every opening
    // on it, so keying on it would merge unrelated roles at one employer —
    // decision 7's silent wrong merge, arriving through a new door.
    expect(document.documentElement.innerHTML).toContain('hiring_plan_id')
    expect(extract(document, GREENHOUSE_URL).fields.atsReqId).toBeNull()
  })
})

describe('tier ranking', () => {
  it('ranks a link preview below a selector that knows the site', () => {
    // The roadmap put OpenGraph second, above both remaining tiers. On a page
    // with no JSON-LD — which is every Greenhouse page — that would let social
    // preview copy beat the board's own markup, and the welded string would go
    // straight into the title dedupe key.
    const document = parseHtml(
      `<html><head>
         <title>Job Application for Senior Engineer at Initech</title>
         <meta property="og:title" content="Initech: Senior Engineer (Remote, US)">
       </head>
       <body><div class="job__title"><h1>Senior Engineer</h1></div></body></html>`,
    )

    expect(readMeta(document).jobTitle).toBe('Initech: Senior Engineer (Remote, US)')

    const result = extract(document, GREENHOUSE_URL)
    expect(result.fields.jobTitle).toBe('Senior Engineer')
    expect(result.provenance.jobTitle).toBe('dom')
  })

  it('ranks a link preview below the board’s own state blob', () => {
    const document = parseHtml(
      `<html><head>
         <meta property="og:title" content="Initech: Senior Engineer (Remote, US)">
         <script>window.__remixContext = ${JSON.stringify({
           state: {
             loaderData: {
               main: { jobPost: { title: 'Senior Engineer', company_name: 'Initech' } },
             },
           },
         })};</script>
       </head><body></body></html>`,
    )

    const result = extract(document, GREENHOUSE_URL)
    expect(result.fields.jobTitle).toBe('Senior Engineer')
    expect(result.provenance.jobTitle).toBe('appstate')
  })
})

describe('lever', () => {
  const document = loadFixture('lever-job.html')

  it('reads the posting from schema.org JobPosting', () => {
    expect(readJsonLd(document)).toMatchObject({
      company: 'Lever Demo 2',
      jobTitle: 'Software Engineer',
      location: 'Bay Area, CA',
    })
  })

  it('reads title, location and employer from the DOM alone', () => {
    expect(leverReaders.readDom(document)).toMatchObject({
      company: 'Lever Demo 2',
      jobTitle: 'Software Engineer',
      location: 'Bay Area, CA',
    })
  })

  it('falls back to the logo’s alt text when the title cannot be split', () => {
    const document = parseHtml(
      `<html><head><title>Acme - Senior Engineer - Remote</title></head>
       <body><div class="main-header-content"><img alt="Acme Corp logo"></div>
       <div class="posting-headline"><h2>Senior Engineer</h2></div></body></html>`,
    )

    expect(leverReaders.readDom(document).company).toBe('Acme Corp')
  })

  it('splits the role out of the page title when the headline is gone', () => {
    // A redesign that takes out both the JSON-LD block and `.posting-headline
    // h2` would otherwise leave the meta tier answering, and `og:title` on
    // these pages is "{Company} - {Title}" — the whole string, welded. That
    // string would then key the company-plus-title dedupe fallback
    // (decision 7).
    const document = parseHtml(
      `<html><head><title>Acme Corp - Senior Engineer</title>
       <meta property="og:title" content="Acme Corp - Senior Engineer"></head>
       <body><div class="posting-categories">
         <div class="posting-category location">Berlin</div>
       </div></body></html>`,
    )

    expect(leverReaders.readDom(document)).toMatchObject({
      company: 'Acme Corp',
      jobTitle: 'Senior Engineer',
    })
    expect(extract(document, LEVER_URL).fields.jobTitle).toBe('Senior Engineer')
  })

  it('reads Lever’s own workplace-type label when the employer set one', () => {
    const document = parseHtml(
      `<html><body><div class="posting-headline"><h2>Engineer</h2>
       <div class="posting-categories">
         <div class="posting-category location">Berlin</div>
         <div class="posting-category workplaceTypes">Hybrid</div>
       </div></div></body></html>`,
    )

    expect(leverReaders.readDom(document)).toMatchObject({
      location: 'Berlin',
      workMode: 'hybrid',
    })
  })

  it('prefers JSON-LD over the DOM for the fields both have', () => {
    const result = extract(document, LEVER_URL)

    expect(result.source).toBe('lever')
    expect(result.fields).toMatchObject({
      company: 'Lever Demo 2',
      jobTitle: 'Software Engineer',
      location: 'Bay Area, CA',
    })
    expect(result.provenance.jobTitle).toBe('jsonld')
  })

  it('does not let the link preview’s welded title win', () => {
    // `og:title` here is "Lever Demo 2 - Software Engineer". The roadmap ranked
    // meta second, which would have put that string in `jobTitle` and then into
    // the title dedupe key.
    expect(readMeta(document).jobTitle).toBe('Lever Demo 2 - Software Engineer')
    expect(extract(document, LEVER_URL).fields.jobTitle).toBe('Software Engineer')
  })
})

describe('ashby', () => {
  const document = loadFixture('ashby-job.html')

  it('reads the posting from schema.org JobPosting', () => {
    expect(readJsonLd(document)).toMatchObject({
      company: 'Ramp',
      jobTitle: 'Software Engineer, Stablecoin',
      location: 'New York City, NY, USA',
    })
  })

  it('reads the posting from Ashby’s own state blob', () => {
    // Reached by parsing the script element's *text*: a content script runs in
    // an isolated world and cannot see `window.__appData`.
    expect(ashbyReaders.readAppState(document)).toMatchObject({
      company: 'Ramp',
      jobTitle: 'Software Engineer, Stablecoin',
      location: 'New York, NY (HQ) · San Francisco, CA',
      workMode: 'hybrid',
    })
  })

  it('needs the lazy pattern, because the loader script follows the JSON', () => {
    // Ashby's bundle loader sits in the same script and contains `};`, so a
    // greedy match runs past the end of the object and does not parse. If a
    // retrim of the fixture drops that trailing function expression, this test
    // stops proving anything and `readScriptJson`'s pattern order stops being
    // exercised at all.
    const script = [...document.querySelectorAll('script:not([src])')]
      .map((element) => element.textContent ?? '')
      .find((text) => text.includes('window.__appData'))

    expect(script).toBeDefined()
    expect(
      /window\.__appData\s*=\s*(\{[\s\S]*\})\s*;/.exec(script ?? '')?.[1],
    ).toBeDefined()
    expect(() =>
      JSON.parse(/window\.__appData\s*=\s*(\{[\s\S]*\})\s*;/.exec(script ?? '')?.[1] ?? ''),
    ).toThrow()
  })

  it('reads employer and role from the page title, having no markup to read', () => {
    // The entire DOM tier. Ashby's body is a spinner — see the next test — so
    // `<title>` is the only thing on the page a selector could reach.
    expect(ashbyReaders.readDom(document)).toMatchObject({
      company: 'Ramp',
      jobTitle: 'Software Engineer, Stablecoin',
    })
  })

  it('takes the last " @ " when the role itself contains one', () => {
    const document = parseHtml(
      '<html><head><title>Engineer @ Scale @ Initech</title></head><body></body></html>',
    )

    expect(ashbyReaders.readDom(document).company).toBe('Initech')
  })

  it('is served an empty shell, which is why there are no selectors', () => {
    // Not an artefact of trimming the fixture: Ashby renders the posting
    // client-side into `#root` under hashed CSS-module class names. Anyone
    // tempted to add a `.job-title` selector to this adapter should see this
    // fail to find one.
    expect(document.querySelector('h1')).toBeNull()
    expect(document.querySelector('#root')).not.toBeNull()
    expect(document.querySelector('#root')?.textContent?.trim()).toBe('')
  })

  it('calls a hybrid role hybrid, though the JSON-LD calls it remote', () => {
    // The bug this adapter is shaped around. Ashby emits
    // `jobLocationType: TELECOMMUTE` on everything that is not `OnSite`, so on
    // a hybrid posting schema.org's own field says remote while the board's
    // `workplaceType` says Hybrid. `TIER_ORDER` puts jsonld above appstate, so
    // without the strip in `readJsonLdFields` the wrong answer wins silently.
    //
    // Both halves are asserted deliberately. The day Ashby fixes its markup,
    // the first expectation fails and tells you, rather than the second one
    // quietly starting to pass for a different reason.
    expect(readJsonLd(document).workMode).toBe('remote')
    expect(ashbyReaders.readJsonLdFields(document)).not.toHaveProperty('workMode')

    const result = extract(document, ASHBY_URL)

    expect(result.fields.workMode).toBe('hybrid')
    expect(result.provenance.workMode).toBe('appstate')
  })

  it('extracts the whole record, crediting the strongest tier that answered', () => {
    const result = extract(document, ASHBY_URL)

    expect(result.source).toBe('ashby')
    expect(result.adapterVersion).toBe('ashby@1')
    expect(result.fields).toMatchObject({
      company: 'Ramp',
      jobTitle: 'Software Engineer, Stablecoin',
      workMode: 'hybrid',
    })
    expect(result.fields.salary).toMatchObject({ min: 189000, max: 330000, period: 'year' })
    expect(result.provenance.company).toBe('jsonld')
    expect(result.provenance.salary).toBe('jsonld')
  })

  it('still lets JSON-LD win the location, which is narrower but not wrong', () => {
    // The obvious follow-up to the work-mode strip is to strip this too: the
    // blob knows the role is in New York *and* San Francisco and the JSON-LD
    // names only the first. But "New York City, NY, USA" is a true statement
    // about this job, where "remote" was a false one, and thinning the trusted
    // tier every time a lower one is more detailed is how tier order stops
    // meaning anything. Incomplete is not the same failure as wrong.
    expect(extract(document, ASHBY_URL).fields.location).toBe('New York City, NY, USA')
    expect(ashbyReaders.readAppState(document).location).toBe(
      'New York, NY (HQ) · San Francisco, CA',
    )
  })

  it('falls back to the state blob when the JSON-LD is gone', () => {
    const withoutJsonLd = parseHtml(
      document.documentElement.outerHTML.replace(
        /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
        '',
      ),
    )

    const result = extract(withoutJsonLd, ASHBY_URL)

    expect(result.fields).toMatchObject({
      company: 'Ramp',
      jobTitle: 'Software Engineer, Stablecoin',
      location: 'New York, NY (HQ) · San Francisco, CA',
      workMode: 'hybrid',
    })
    expect(result.provenance.company).toBe('appstate')
  })

  it('loses the work mode rather than inventing one when the blob is gone', () => {
    // This is what a re-parsed snapshot looks like: `buildSnapshot` drops inline
    // non-JSON-LD scripts, so the appstate tier is simply not there. The work
    // mode then has no honest source — jsonld's is the wrong one — and comes
    // back null. A gap the user can fill from a dropdown is the right way for
    // this to fail.
    const withoutState = parseHtml(
      document.documentElement.outerHTML.replace(
        /<script nonce="[^"]*">[\s\S]*?<\/script>/,
        '',
      ),
    )

    const result = extract(withoutState, ASHBY_URL)

    expect(result.fields).toMatchObject({
      company: 'Ramp',
      jobTitle: 'Software Engineer, Stablecoin',
    })
    expect(result.fields.workMode).toBeNull()
  })

  it('offers nothing on a board’s listing page, link preview included', () => {
    // `/{org}` is inside `content_scripts.matches` and carries the same blob
    // with `posting: null`. The posting tiers say nothing there on their own —
    // but `og:title` on the real page is "Ramp Jobs", and the shared meta tier
    // would hand that back as a job title. `isWorthOffering` needs only a
    // title, so the panel would offer to track "Ramp Jobs" as a role.
    //
    // Found by running this adapter against a real untrimmed board page; the
    // hand-written version of this test passed happily without the og:title.
    const listing = parseHtml(
      `<html><head><title>Ramp Jobs</title>
       <meta property="og:title" content="Ramp Jobs"></head>
       <body><script>window.__appData = ${JSON.stringify({
         organization: { name: 'Ramp' },
         posting: null,
       })};</script></body></html>`,
    )

    expect(readMeta(listing).jobTitle).toBe('Ramp Jobs')
    expect(ashbyReaders.readAppState(listing)).toEqual({})
    expect(ashbyReaders.readMetaFields(listing)).toEqual({})

    const result = extract(listing, 'https://jobs.ashbyhq.com/ramp')

    expect(result.fields.company).toBeNull()
    expect(result.fields.jobTitle).toBeNull()
  })

  it('keeps the link preview when there is no blob to say otherwise', () => {
    // The other side of the guard. A re-parsed snapshot has no inline scripts
    // at all, and suppressing the lower tiers on a missing blob would throw
    // away a real posting to avoid a hypothetical listing page.
    const snapshotted = parseHtml(
      `<html><head><title>Staff Engineer @ Initech</title>
       <meta property="og:title" content="Staff Engineer"></head><body></body></html>`,
    )

    expect(ashbyReaders.readMetaFields(snapshotted).jobTitle).toBe('Staff Engineer')
    expect(extract(snapshotted, ASHBY_URL).fields).toMatchObject({
      company: 'Initech',
      jobTitle: 'Staff Engineer',
    })
  })

  it('ignores a workplace type it has never seen', () => {
    // A fourth value Ashby invents later must read as "nothing said". Sniffing
    // the string instead would let a label like "Remote-first Hybrid" resolve to
    // whichever word the pattern list happens to reach first.
    const document = parseHtml(
      `<html><body><script>window.__appData = ${JSON.stringify({
        organization: { name: 'Initech' },
        posting: {
          title: 'Engineer',
          locationName: 'Austin',
          workplaceType: 'FlexibleAnywhere',
        },
      })};</script></body></html>`,
    )

    expect(ashbyReaders.readAppState(document).workMode).toBeNull()
  })

  it('never writes a requisition id, though the blob states one', () => {
    // `posting.id` really is the requisition — and it is the same value
    // `normalize/ats.ts` already reads out of the URL, where it exists before
    // any parsing and survives into exports. Decision 7: the URL owns that key.
    expect(document.documentElement.innerHTML).toContain(
      'd1183b00-6590-4fe4-a585-28d84e578fe3',
    )
    expect(extract(document, ASHBY_URL).fields.atsReqId).toBeNull()
  })

  it('does not let the link preview answer for a tier that knows more', () => {
    expect(readMeta(document).jobTitle).toBe('Software Engineer, Stablecoin')
    expect(extract(document, ASHBY_URL).provenance.jobTitle).toBe('jsonld')
  })
})

describe('the generic adapter', () => {
  it('reads a rich JSON-LD posting on a site nobody has adapted', () => {
    const document = parseHtml(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebPage', name: 'Careers' },
          {
            '@type': 'JobPosting',
            title: 'Staff Platform Engineer',
            hiringOrganization: { '@type': 'Organization', name: 'Initech' },
            jobLocation: {
              '@type': 'Place',
              address: {
                addressLocality: 'Austin',
                addressRegion: 'TX',
                addressCountry: { name: 'USA' },
              },
            },
            jobLocationType: 'TELECOMMUTE',
            baseSalary: {
              '@type': 'MonetaryAmount',
              currency: 'USD',
              value: { minValue: 180000, maxValue: 220000, unitText: 'YEAR' },
            },
          },
        ],
      })}</script></head><body></body></html>`,
    )

    const result = extract(document, 'https://careers.initech.example/jobs/9')

    expect(result.source).toBe('generic')
    expect(result.fields).toMatchObject({
      company: 'Initech',
      jobTitle: 'Staff Platform Engineer',
      location: 'Austin, TX, USA',
      workMode: 'remote',
    })
    expect(result.fields.salary).toMatchObject({ min: 180000, max: 220000, period: 'year' })
    expect(result.confidence).toBeGreaterThan(0.9)
  })

  it('gets a title and nothing else from a page with only a link preview', () => {
    const document = parseHtml(
      `<html><head><meta property="og:title" content="Backend Engineer"></head><body></body></html>`,
    )

    const result = extract(document, 'https://jobs.example/1')

    expect(result.fields.jobTitle).toBe('Backend Engineer')
    // No company: `og:title` alone cannot say who is hiring, and a guess would
    // land in a join key.
    expect(result.fields.company).toBeNull()
    expect(result.confidence).toBeLessThan(0.4)
  })

  it('offers nothing when the page is not a posting', () => {
    const document = parseHtml('<html><head><title>Blog</title></head><body></body></html>')

    expect(extract(document, 'https://example.com/').fields.company).toBeNull()
  })
})

describe('robustness', () => {
  it('survives malformed JSON-LD without losing the tiers below it', () => {
    const document = parseHtml(
      `<html><head>
        <script type="application/ld+json">{ this is not json </script>
        <meta property="og:title" content="Backend Engineer">
      </head><body></body></html>`,
    )

    expect(extract(document, 'https://jobs.example/1').fields.jobTitle).toBe(
      'Backend Engineer',
    )
  })

  it('survives a state blob that matches but does not parse', () => {
    const document = parseHtml(
      `<html><head>
        <title>Job Application for Backend Engineer at Initech</title>
        <script>window.__remixContext = {oops;</script>
      </head><body></body></html>`,
    )

    expect(extract(document, GREENHOUSE_URL).fields).toMatchObject({
      company: 'Initech',
      jobTitle: 'Backend Engineer',
    })
  })

  it('does not throw on an empty document', () => {
    expect(() => extract(parseHtml(''), GREENHOUSE_URL)).not.toThrow()
    expect(extract(parseHtml(''), GREENHOUSE_URL).confidence).toBe(0)
  })
})

describe('workday', () => {
  const document = loadFixture('workday-job.html')

  it('routes to its own adapter, on any tenant and any data centre', () => {
    expect(selectAdapter(WORKDAY_URL).name).toBe('workday')
    expect(
      selectAdapter('https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/E_R1234')
        .name,
    ).toBe('workday')
    // The suffix trick, for the same reason every other adapter has this test.
    expect(selectAdapter('https://notmyworkdayjobs.com/x').name).toBe('generic')
  })

  it('reads company, title and location from schema.org, as generic already did', () => {
    // The diagnostic that prompted this adapter reported `generic@1` at 0.79
    // coverage on the live page, so these three were never the gap. Asserted
    // anyway: an adapter that took the routing and then read *less* than the
    // fallback it displaced would be a silent regression.
    expect(readJsonLd(document)).toMatchObject({
      company: 'Premera Blue Cross',
      jobTitle: 'Software Development Engineer III, React and React Native',
      location: 'WA Mountlake Terrace Orcas, United States of America',
    })
  })

  it('reads the requisition from `identifier`, which the shared tier declines to', () => {
    // `jsonld.ts` does not read `identifier` because boards generally put an
    // internal record id there, and it reserves the exception for an adapter
    // that finds a genuinely public requisition. This is that exception: the
    // value matches the requisition the URL is addressed by.
    expect(readJsonLd(document).atsReqId).toBeUndefined()
    expect(workday.readers[0]!.read(document)).toMatchObject({ atsReqId: 'R28643' })
  })

  it('reads the work mode from the first line of the description', () => {
    // `jobLocationType` is absent on both captured postings, so this prefix is
    // the only statement of it on the page.
    expect(readJsonLd(document).workMode).toBeNull()
    expect(workday.readers[0]!.read(document)).toMatchObject({ workMode: 'hybrid' })
  })

  it('does not go looking for the mode further down the description', () => {
    // Anchored to the start on purpose. Eight kilobytes of employer prose
    // follows, and a loose search through it finds "remote" in a sentence about
    // remote teams and relabels an onsite job.
    const loose = parseHtml(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Engineer',
        description:
          'Join our team. We support remote collaboration across our fully onsite offices.',
      })}</script>`,
    )

    // Proving the node was found and only the anchoring suppressed the answer.
    // Without this the assertion below passes just as well on a document where
    // no `JobPosting` was located at all, which is the vacuous version of it.
    expect(readJsonLd(loose).jobTitle).toBe('Engineer')
    expect(workday.readers[0]!.read(loose).workMode).toBeUndefined()
  })

  it('leaves salary alone, because the range on this page is prose', () => {
    // Premera states a range — Washington requires one — as text in the middle
    // of the description, and `salary.ts` parses `baseSalary` and nothing else
    // on the argument that a wrong salary is worse than a missing one. This
    // asserts the decision rather than the absence: the fixture keeps the real
    // phrasing so that a change of heart has something to work against.
    expect(extract(document, WORKDAY_URL).fields.salary).toBeNull()

    const described = document.querySelector('script[type="application/ld+json"]')
    expect(described?.textContent).toContain('Salary Range')
  })

  it('has no DOM tier, because the body is empty', () => {
    // Not a stylistic choice. Workday renders client-side and serves a shell;
    // there is nothing in the body for a selector to reach, so a DOM tier would
    // be inventing site knowledge that no page would confirm.
    expect(workday.readers.map((reader) => reader.tier)).toEqual([
      'jsonld',
      'jsonld',
      'meta',
    ])
    expect(document.body.textContent?.trim()).toBe('')
  })

  it('produces the whole record the panel would fill from', () => {
    const { fields, provenance, source, adapterVersion } = extract(document, WORKDAY_URL)

    expect(source).toBe('workday')
    expect(adapterVersion).toBe('workday@1')
    expect(fields).toMatchObject({
      company: 'Premera Blue Cross',
      jobTitle: 'Software Development Engineer III, React and React Native',
      workMode: 'hybrid',
      atsReqId: 'R28643',
      salary: null,
    })
    expect(provenance.atsReqId).toBe('jsonld')
    expect(provenance.workMode).toBe('jsonld')
  })
})
