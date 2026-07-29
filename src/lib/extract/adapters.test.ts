// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { loadFixture, parseHtml } from '../../test/dom'
import { extract, selectAdapter } from './index'
import { greenhouseReaders } from './adapters/greenhouse'
import { leverReaders } from './adapters/lever'
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

describe('selectAdapter', () => {
  it('routes each board to its own adapter', () => {
    expect(selectAdapter(GREENHOUSE_URL).name).toBe('greenhouse')
    expect(selectAdapter('https://boards.greenhouse.io/acme/jobs/1').name).toBe(
      'greenhouse',
    )
    expect(selectAdapter(LEVER_URL).name).toBe('lever')
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
