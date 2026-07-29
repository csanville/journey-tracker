import { describe, expect, it } from 'vitest'
import { aPosting, freshDb } from '../test/factories'
import { normalizePostingInput } from './normalize'
import { findDuplicate, getPosting, upsertPosting } from './repository'
import type { PostingInput } from './types'

/**
 * The phase gate: messy real-world input reaching the database through the real
 * write path, and collapsing — or not — as it should.
 *
 * These run against the repository rather than the pure functions on purpose.
 * The normalizers are unit-tested next door; what is under test here is that the
 * write path actually applies them and that the two dedupe keys behave when a
 * record is genuinely on disk.
 */
/**
 * Like `aPosting`, but with no requisition id unless a case asks for one.
 *
 * The shared factory supplies a fixed `REQ-4021`, and a caller-supplied id wins
 * over the URL by design — so leaving it in place would mean every fixture here
 * matched on that one constant instead of on the URL under test, and cases would
 * pass without exercising extraction at all.
 */
function posting(overrides: Partial<PostingInput> = {}): PostingInput {
  return aPosting({ atsReqId: null, ...overrides })
}

describe('derived join keys', () => {
  it('normalizes company and URL on the way in, whatever the caller sent', async () => {
    const db = await freshDb()

    const stored = await upsertPosting(
      db,
      posting({
        company: 'Acme, Inc.',
        url: 'https://www.boards.greenhouse.io/acme/jobs/4012345?utm_source=linkedin',
        // Deliberately wrong. The caller does not get to decide the keys.
        companyNormalized: 'WHATEVER',
        canonicalUrl: 'https://wrong.example',
        atsReqId: null,
      }),
    )

    expect(stored.companyNormalized).toBe('acme')
    expect(stored.canonicalUrl).toBe('https://boards.greenhouse.io/acme/jobs/4012345')
    expect(stored.atsReqId).toBe('4012345')
    // The verbatim value the page gave is what the UI shows, and it survives.
    expect(stored.company).toBe('Acme, Inc.')
  })

  it('keeps a requisition id the caller extracted from the page', async () => {
    const db = await freshDb()

    const stored = await upsertPosting(
      db,
      posting({ url: 'https://acme.com/careers/engineer', atsReqId: 'REQ-99' }),
    )

    expect(stored.atsReqId).toBe('REQ-99')
  })

  it('does not treat re-normalizing a stored record as an edit', async () => {
    const db = await freshDb()
    const input = posting({ company: 'Acme, Inc.', url: 'https://acme.com/j?utm_source=x' })

    const first = await upsertPosting(db, input)
    // What a retry looks like once the keys have been derived once.
    const second = await upsertPosting(db, normalizePostingInput(input))

    expect(second.updatedAt).toBe(first.updatedAt)
  })
})

describe('findDuplicate', () => {
  it('matches the same posting reached through a tracked link', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({ id: 'a', url: 'https://boards.greenhouse.io/acme/jobs/4012345' }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        url: 'http://www.boards.greenhouse.io/acme/jobs/4012345/?utm_campaign=q3&gh_src=x',
      }),
    )

    expect(found?.posting.id).toBe('a')
  })

  it('matches across routes that never converge on a URL', async () => {
    const db = await freshDb()
    // Found first on the company's embedded board...
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Acme, Inc.',
        url: 'https://acme.com/careers?gh_jid=4012345',
      }),
    )

    // ...then again on the Greenhouse board itself. Different canonical URLs,
    // same requisition at the same employer.
    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'ACME Incorporated',
        url: 'https://boards.greenhouse.io/acme/jobs/4012345',
      }),
    )

    expect(found?.posting.id).toBe('a')
  })

  it('matches when the board reworded its own title', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Acme',
        jobTitle: 'Senior Software Engineer',
        url: 'https://acme.com/careers?gh_jid=4012345',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Acme',
        jobTitle: 'Senior Software Engineer (Platform)',
        url: 'https://boards.greenhouse.io/acme/jobs/4012345',
      }),
    )

    // Title is not in the key precisely so this still matches.
    expect(found?.posting.id).toBe('a')
  })

  it('does not report a record as its own duplicate', async () => {
    const db = await freshDb()
    const input = posting({
      id: 'a',
      url: 'https://boards.greenhouse.io/acme/jobs/4012345',
    })
    await upsertPosting(db, input)

    expect(await findDuplicate(db, input)).toBeNull()
  })

  it('gives the same answer whichever of the pair is asked about', async () => {
    const db = await freshDb()
    const url = 'https://acme.com/careers/engineer'
    await upsertPosting(db, posting({ id: 'a', url }))
    await upsertPosting(db, posting({ id: 'b', url }))

    // Reachable by design: this reports duplicates without merging them, so the
    // form may well keep both. Taking the first index hit and discarding it for
    // being the record itself made `findDuplicate(a)` claim `a` was unique.
    expect((await findDuplicate(db, posting({ id: 'a', url })))?.posting.id).toBe('b')
    expect((await findDuplicate(db, posting({ id: 'b', url })))?.posting.id).toBe('a')
  })

  it('returns null when there is nothing to match', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Acme',
        jobTitle: 'Engineer',
        url: 'https://acme.com/jobs/1',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Globex',
        jobTitle: 'Designer',
        url: 'https://other.com/9',
      }),
    )

    expect(found).toBeNull()
  })
})

describe('findDuplicate on company and title', () => {
  it('catches the same role entered twice by hand, with no URL or requisition', async () => {
    const db = await freshDb()
    // The case that started this: a posting filed in detail, then filed again
    // later without realising. Neither has a URL or a requisition, so the two
    // identity keys have nothing to work with.
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Roadrunner',
        jobTitle: 'Staff Engineer',
        url: '',
        notes: 'lots of detail',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({ id: 'b', company: 'Roadrunner', jobTitle: 'Staff Engineer', url: '' }),
    )

    expect(found?.posting.id).toBe('a')
    // Reported as a resemblance, so the UI can ask rather than assert.
    expect(found?.matchedOn).toBe('title')
  })

  it('sees through case and punctuation in the title', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Roadrunner',
        jobTitle: 'Senior Software Engineer',
        url: '',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Roadrunner',
        jobTitle: '  senior software  engineer ',
        url: '',
      }),
    )

    expect(found?.posting.id).toBe('a')
  })

  it('reports the strongest key that matched, not the weakest', async () => {
    const db = await freshDb()
    const url = 'https://boards.greenhouse.io/roadrunner/jobs/4012345'
    await upsertPosting(db, posting({ id: 'a', company: 'Roadrunner', url }))

    // Same URL, same company, same title — all three keys would match.
    expect(
      (await findDuplicate(db, posting({ id: 'b', company: 'Roadrunner', url })))
        ?.matchedOn,
    ).toBe('url')
  })

  it('does not fire when two known requisitions differ', async () => {
    const db = await freshDb()
    // A large employer posting one role for two teams. The requisitions are the
    // ATS's own identities and they disagree, which settles it whatever the
    // title says.
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Roadrunner',
        jobTitle: 'Software Engineer',
        url: 'https://boards.greenhouse.io/roadrunner/jobs/4012345',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Roadrunner',
        jobTitle: 'Software Engineer',
        url: 'https://boards.greenhouse.io/roadrunner/jobs/4012346',
      }),
    )

    expect(found).toBeNull()
  })

  it('does not fire on two listings from one board', async () => {
    const db = await freshDb()
    // Same host, different paths, no requisitions to compare. The board is
    // telling us these are two listings, so the shared title means nothing.
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Roadrunner',
        jobTitle: 'Software Engineer',
        url: 'https://roadrunner.com/careers/eng-platform',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Roadrunner',
        jobTitle: 'Software Engineer',
        url: 'https://roadrunner.com/careers/eng-infra',
      }),
    )

    expect(found).toBeNull()
  })

  it('still fires for one posting seen on two different sites', async () => {
    const db = await freshDb()
    // Different hosts settle nothing: this is the aggregator case, and it is
    // the reason the title key exists at all. Suppressing on any URL
    // difference would throw it away.
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Roadrunner',
        jobTitle: 'Software Engineer',
        url: 'https://www.linkedin.com/jobs/view/3812345678',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Roadrunner',
        jobTitle: 'Software Engineer',
        url: 'https://roadrunner.com/careers/eng-platform',
      }),
    )

    expect(found?.posting.id).toBe('a')
    expect(found?.matchedOn).toBe('title')
  })

  it('does not fire on the same title at a different employer', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({ id: 'a', company: 'Roadrunner', jobTitle: 'Staff Engineer', url: '' }),
    )

    const found = await findDuplicate(
      db,
      posting({ id: 'b', company: 'Globex', jobTitle: 'Staff Engineer', url: '' }),
    )

    expect(found).toBeNull()
  })

  it('does not fire when the title is unknown', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({ id: 'a', company: 'Roadrunner', jobTitle: '', url: '' }),
    )

    const found = await findDuplicate(
      db,
      posting({ id: 'b', company: 'Roadrunner', jobTitle: '', url: '' }),
    )

    // An empty title would otherwise match every untitled posting at the
    // employer, the same way an empty company or URL would.
    expect(found).toBeNull()
  })
})

describe('findDuplicate does not merge', () => {
  it('two requisitions at the same company', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Acme',
        url: 'https://boards.greenhouse.io/acme/jobs/4012345',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Acme',
        url: 'https://boards.greenhouse.io/acme/jobs/4012346',
      }),
    )

    expect(found).toBeNull()
  })

  it('the same requisition number at two different companies', async () => {
    const db = await freshDb()
    // Requisition numbers are only unique within an ATS tenant. R-12345 at one
    // employer has nothing to do with R-12345 at another.
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Acme',
        url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/SF/Engineer_R-12345',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Globex',
        url: 'https://globex.wd1.myworkdayjobs.com/en-US/External/job/NY/Engineer_R-12345',
      }),
    )

    expect(found).toBeNull()
  })

  it('two different roles at one company when neither has a requisition id', async () => {
    const db = await freshDb()
    // The dangerous case. With no requisition and no URL match, a key of company
    // alone would collapse every posting at this employer.
    await upsertPosting(
      db,
      posting({
        id: 'a',
        company: 'Acme',
        jobTitle: 'Staff Engineer',
        url: 'https://acme.com/careers/engineer',
      }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Acme',
        jobTitle: 'Product Designer',
        url: 'https://acme.com/careers/designer',
      }),
    )

    expect(found).toBeNull()
    expect(await getPosting(db, 'a')).not.toBeNull()
  })

  it('a division and its parent', async () => {
    const db = await freshDb()
    await upsertPosting(
      db,
      posting({ id: 'a', company: 'Acme', url: 'https://acme.com/careers?gh_jid=4012345' }),
    )

    const found = await findDuplicate(
      db,
      posting({
        id: 'b',
        company: 'Acme Health',
        url: 'https://acmehealth.com/careers?gh_jid=4012345',
      }),
    )

    expect(found).toBeNull()
  })

  it('two postings with no URL at all', async () => {
    const db = await freshDb()
    // An empty canonical URL is a valid IndexedDB key and matches itself, so
    // without a guard these two are reported as one posting.
    await upsertPosting(db, posting({ id: 'a', company: 'Acme', url: '' }))

    const found = await findDuplicate(db, posting({ id: 'b', company: 'Globex', url: '' }))

    expect(found).toBeNull()
  })

  it('two postings whose URL never parsed', async () => {
    const db = await freshDb()
    await upsertPosting(db, posting({ id: 'a', company: 'Acme', url: 'n/a' }))

    const found = await findDuplicate(
      db,
      posting({ id: 'b', company: 'Globex', url: 'n/a' }),
    )

    expect(found).toBeNull()
  })

  it('two postings whose companies are unknown', async () => {
    const db = await freshDb()
    await upsertPosting(db, posting({ id: 'a', company: '', url: 'https://a.example/1' }))

    const found = await findDuplicate(
      db,
      posting({ id: 'b', company: '', url: 'https://b.example/2' }),
    )

    // An empty normalized company must never act as a key that matches itself.
    expect(found).toBeNull()
  })
})
