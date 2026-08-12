import type { Adapter, ExtractedFields } from '../types'
import { readJsonLd, jobPostingFrom } from '../tiers/jsonld'
import { readMeta } from '../tiers/meta'
import { inferWorkMode } from '../workmode'
import { cleanText } from '../text'

/**
 * Workday — `<tenant>.wdN.myworkdayjobs.com`.
 *
 * The first board whose host is per-tenant, and the reason the manifest carries
 * its only wildcard (decision 2's amendment). It is also the first adapter
 * written *after* seeing the page rather than before: a diagnostic pulled from a
 * live tenant said `generic@1` already read it at 0.79 coverage, which made this
 * a smaller job than the roadmap had planned for and a better specified one.
 *
 * **There is no DOM tier, and here that is not a judgement call.** Workday
 * serves a shell whose `<body>` is twenty-three characters of whitespace and
 * renders everything client-side. Ashby's adapter gives the same reason with a
 * spinner to point at; this one has nothing at all to select. Every field comes
 * out of the head.
 *
 * What this adds over `generic` is two fields, and both are Workday facts that a
 * general-purpose reader has no business assuming:
 *
 * 1. **The requisition, from `identifier`.** `jsonld.ts` deliberately does not
 *    read that key, and says why — boards put their internal record id there,
 *    which is a different number from the requisition in the URL, and letting it
 *    win would hand `deriveJoinKeys` a key matching nothing. It then reserves
 *    the exception: "the field stays in `ExtractedFields` for an adapter that
 *    finds a genuinely public requisition number on the page; today none does."
 *    Workday is that adapter. On both captured postings `identifier.value` is
 *    the requisition the URL is addressed by.
 *
 * 2. **The work mode, from the first line of the description.** `jobLocationType`
 *    is absent on both postings, so `Workforce Classification: Hybrid` is the
 *    only statement of it anywhere on the page.
 *
 * **Salary is deliberately not read.** Premera's range is real and public —
 * Washington requires it — and it is prose in the middle of the description:
 * "National Plus Salary Range: $111,900.00 - $190,200.00". `salary.ts` parses
 * schema.org `baseSalary` and nothing else, on the argument that a missed salary
 * costs a copy-paste while a wrong one is an authoritative-looking number that
 * is off by a factor of twelve. That argument is not weaker here, so this
 * adapter leaves the field alone rather than quietly making Workday the
 * exception to it.
 */

/**
 * `Workforce Classification: Hybrid`, the first line of every Workday
 * description these captures contain.
 *
 * Anchored to the start of the description rather than searched for anywhere in
 * it. Eight kilobytes of employer prose follows, and a loose search through it
 * would eventually find the word "remote" in a sentence about remote *teams* and
 * relabel an onsite job. The label is a prefix or it is not read.
 *
 * **The capture is one word, and the version before it was 40 characters.** That
 * looked like the same anchoring argument applied to the value, and it was not:
 * the window is whitespace-collapsed before this runs, so the `\n` that bounded
 * the old class could never appear in it, and the capture ran forty characters
 * into the sentence *after* the label every time. `inferWorkMode` then saw the
 * label plus the prose, and its hybrid-over-remote-over-onsite precedence
 * answered about whichever word it liked best — "On-Site Remote work is not
 * available for this position" read as `remote`, and "Remote This role is not
 * hybrid" read as `hybrid`. Two fields inverted on postings that stated
 * themselves plainly.
 *
 * A review found it; the fixture could not, because Premera's value is `Hybrid`
 * and hybrid wins that precedence no matter what bleeds in beside it. That is
 * this file's own warning about a test passing for a reason unrelated to its
 * claim, landing on the file that made it.
 *
 * The observed vocabulary is a single token, hyphens included: `Hybrid`,
 * `On-Site`, `Remote`. A two-word value would capture only its first word and
 * `inferWorkMode` would answer `null` — a missed field rather than an inverted
 * one, which is the direction this project's parsers are meant to fail in.
 */
const CLASSIFICATION = /^workforce classification:\s*([a-z][a-z-]{1,20})/i

/**
 * How much of the description the label is looked for in.
 *
 * The label is the first thing in it, so this only has to be long enough to
 * contain the label and short enough to be obviously not a search of the whole
 * text. Both halves matter: the real description runs to eight kilobytes and
 * says "on-site" three times past the four-thousandth character, in sentences
 * about the employer's offices rather than about this job.
 *
 * **Not `cleanText`, which is what the first version of this used and why it
 * silently found nothing on the live page.** That helper rejects anything over
 * 300 characters — correctly, for a *field value*, where a string that long
 * means a selector matched a container instead of a label. A description is not
 * a field value; it is the haystack. Passing one through a guard designed to
 * reject haystacks returned `null` for every real posting, while the trimmed
 * fixture sat just under the cap and passed.
 */
const CLASSIFICATION_WINDOW = 200

function readWorkdayJsonLd(document: Document): Partial<ExtractedFields> {
  const posting = jobPostingFrom(document)
  if (!posting) return {}

  const fields: Partial<ExtractedFields> = {}

  const identifier = posting.identifier
  const value =
    identifier && typeof identifier === 'object'
      ? cleanText((identifier as { value?: unknown }).value as string | null)
      : cleanText(typeof identifier === 'string' ? identifier : null)
  if (value) fields.atsReqId = value

  const described = typeof posting.description === 'string' ? posting.description : null
  // Whitespace collapsed the way `cleanText` does it, including the non-breaking
  // space boards emit constantly, but without its length rejection — see
  // `CLASSIFICATION_WINDOW`.
  const opening = described
    ? described
        .slice(0, CLASSIFICATION_WINDOW)
        .replace(/[\s ]+/g, ' ')
        .trim()
    : null
  const classified = opening ? CLASSIFICATION.exec(opening) : null
  // `inferWorkMode` rather than a lookup table: Workday lets the employer write
  // this label, so it is prose in a fixed position rather than a closed
  // vocabulary, and it has the sense to answer `null` for something it does not
  // recognise instead of guessing.
  const workMode = classified ? inferWorkMode(classified[1]) : null
  if (workMode) fields.workMode = workMode

  return fields
}

export const workday: Adapter = {
  name: 'workday',
  version: 1,
  // Every tenant and every data centre: `premera.wd5`, `acme.wd1`. Anchored on
  // the domain rather than a suffix match, so a host merely ending in these
  // letters is not accepted — the trick `ats.ts` guards against too.
  matches: (url) => /(^|\.)myworkdayjobs\.com$/.test(url.hostname),
  readers: [
    // Workday's own reading first, then the general one. `mergeTiers` keeps the
    // earlier answer for a field, so the two above win where this adapter has an
    // opinion and everything else — company, title, location — comes from the
    // ordinary JSON-LD reader exactly as it did under `generic`.
    { tier: 'jsonld', read: readWorkdayJsonLd },
    { tier: 'jsonld', read: readJsonLd },
    { tier: 'meta', read: readMeta },
  ],
}
