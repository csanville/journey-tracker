import { isApplicationFlow } from '../lib/flows'

/**
 * The documents a page is actually made of.
 *
 * Every board before iCIMS put the posting in the document the content script
 * runs in, so `extract(document, …)` and the top frame were the same thing and
 * nothing here was needed. The classic iCIMS portal breaks that: the page at
 * `careers-<tenant>.icims.com/jobs/<id>/<slug>/job` is a shell whose `<title>`
 * is "iCIMS Careers Portal" and whose body is one line of text, and the posting
 * — JSON-LD, headings, the requisition — is inside an `<iframe>` it builds at
 * runtime. A diagnostic pulled from a real one reported `coverage 0.00` and six
 * fields `not found` on a page that reads perfectly once you are in the frame.
 *
 * **This is not `all_frames`, and the difference is the URL.** Running the
 * content script in every frame would have each of them report its own
 * `location.href`, which is how decision 2 keeps the `tabs` permission out of
 * the manifest — and the frame's href is not the posting's URL. iCIMS builds it
 * with the viewport in it:
 *
 *     …/job?mobile=false&width=1506&height=500&…&in_iframe=1
 *
 * `url.ts` is a blocklist by deliberate design — "nothing is removed unless it
 * is named here" — so `width` survives canonicalization, and the same posting
 * read at two window sizes canonicalizes to two different URLs and saves as two
 * records. Neither of them matches the URL the user sees, pastes, or arrives
 * from. Reading the child document from the top frame keeps the reported URL the
 * one the address bar shows and leaves every existing invariant alone, including
 * the worker's one-report-per-tab cache, which two frames reporting would race.
 *
 * It costs no permission. The frame is same-origin with its parent, so this is
 * ordinary DOM access rather than anything the extension has to be granted;
 * a cross-origin frame hands back `null` and is skipped, which is also what
 * happens on the Greenhouse and Ashby embeds that live on a company's own
 * careers domain. Those stay out of reach and stay the capture gesture's job.
 */

/**
 * Every address a frame can be said to have, because the two can disagree.
 *
 * `src` is what the page asked for, resolved absolute — and on iCIMS it is the
 * live value, since the page rewrites it with the viewport in it before the
 * frame loads. `location.href` is where the frame actually *is*, which is the
 * one that has moved on if the frame navigated itself after loading.
 *
 * Both are consulted and either one is enough to refuse, which is the direction
 * that fails safe: the caller uses this to decide whether a document may be read
 * at all, so a disagreement between the two should cost a read rather than
 * permit one.
 */
function addressesOf(frame: HTMLIFrameElement, inner: Document): string[] {
  const urls: string[] = []

  try {
    if (frame.src) urls.push(frame.src)
  } catch {
    // Nothing: an unreadable attribute is not evidence either way.
  }

  try {
    if (inner.location?.href) urls.push(inner.location.href)
  } catch {
    // Same.
  }

  return urls
}

/**
 * How many same-origin frames are examined.
 *
 * A cap rather than no cap because this runs on every page load of every
 * matched board, and a page with a hundred frames should cost a hundred null
 * checks and not a hundred parses. Cross-origin frames are not counted against
 * it: rejecting one is a property read, and counting them would let a page of
 * ad iframes push the posting's own frame out of range.
 */
const MAX_SAME_ORIGIN_FRAMES = 8

/**
 * `root` first, then any same-origin frame with something in it that is not an
 * application being filled in.
 *
 * **The flow refusal is repeated here, and today it catches nothing.** `capture`
 * already refuses a page whose URL is an application flow, and it does so before
 * the document is touched — but that guard reads the *top* URL, and this
 * function is a second route to the same destination: a page whose address is a
 * posting, holding a frame whose address is an application. No board is known to
 * be built that way. Workday, the only board `flows.ts` has patterns for, moves
 * into its flow by same-document navigation, so the top URL changes and the
 * existing refusal fires first.
 *
 * It is written anyway because "no board does this" is a fact about today's
 * markup and the guard it would justify skipping is the one protecting the
 * self-identification questionnaire. Phase 12 hit the same shape three times —
 * a guard correct about the route it was written for, with another route left
 * open — and its conclusion was to guard the destination. This is the
 * destination.
 *
 * The refusal is not conditional on `readApplicationFlows`. That option exists
 * because an explicit gesture is consent for *the page the user pointed at*, and
 * a frame inside it is not what they pointed at.
 *
 * Order matters and is not arbitrary: the caller takes the first document worth
 * offering, so the document the user is looking at gets to answer before any
 * frame does. On the four boards that came before iCIMS that is the only
 * document this returns, and their behaviour is unchanged.
 *
 * One level deep. The frame that holds an iCIMS posting holds the posting, not
 * another frame, and a recursive walk would be a way to reach content nobody
 * has yet found a reason to reach.
 */
export function readableDocuments(root: Document): readonly Document[] {
  const documents: Document[] = [root]

  let frames: readonly HTMLIFrameElement[]
  try {
    frames = [...root.querySelectorAll('iframe')]
  } catch {
    // A document detached mid-read, which is ordinary during navigation.
    return documents
  }

  for (const frame of frames) {
    if (documents.length > MAX_SAME_ORIGIN_FRAMES) break

    let inner: Document | null = null
    try {
      // `null` for a cross-origin frame in every browser this runs in. The
      // catch is for the ones that throw instead, and for a frame removed from
      // the document between the query above and this read.
      inner = frame.contentDocument
    } catch {
      inner = null
    }

    // `about:blank` inherits its parent's origin, so an empty frame is reachable
    // rather than refused, and parsing one would cost a full extraction to learn
    // it has nothing. The body check is what tells those apart.
    if (!inner || inner === root || !inner.body || inner.body.childElementCount === 0) {
      continue
    }

    if (addressesOf(frame, inner).some(isApplicationFlow)) continue

    documents.push(inner)
  }

  return documents
}
