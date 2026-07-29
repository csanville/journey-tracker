/**
 * Trimming a page down to the part worth keeping (decision 6).
 *
 * A snapshot exists so that a parser bug found in six months can be fixed and
 * replayed against what the page actually said, instead of being permanently
 * lost data. Decision 6 left "trimmed" and "capped" as words until they were
 * given numbers; this module is those numbers.
 *
 * The design property that makes it work: **a snapshot is itself a parseable
 * document.** What comes out of here is a small, well-formed HTML page carrying
 * the title, the link-preview meta tags, every JSON-LD block verbatim, and the
 * posting's content subtree — which is precisely the input `extract()` takes.
 * Re-parsing a snapshot is therefore the same code path as parsing a live page
 * rather than a second, quietly diverging one, and there is a test that parses a
 * fixture, snapshots it, re-parses the snapshot, and demands the same fields.
 *
 * What is deliberately dropped, and the cost:
 *
 * - **The application form, and every input in it.** This is the PII half of
 *   decision 6 and it is not hypothetical: the real Greenhouse capture embeds a
 *   voluntary self-identification questionnaire — gender, race, veteran and
 *   disability status — in the same state blob that holds the job title. On a
 *   logged-in session those forms are prefilled. None of it is job data and all
 *   of it is the user's.
 * - **Inline scripts other than JSON-LD**, which is where that state blob lives.
 *   The cost is real: Greenhouse's best tier is that blob, so a re-parsed
 *   Greenhouse snapshot falls back to the DOM tier. It loses nothing that
 *   matters — the title, company and location are all still in the kept subtree
 *   and the page title — and it is the only way to keep the questionnaire out.
 */

/** 256KB after trimming, per decision 6. */
export const SNAPSHOT_CAP_BYTES = 256 * 1024

/**
 * Where the posting lives, most specific first.
 *
 * Falls all the way back to `body`, because a snapshot of too much is still a
 * snapshot; the cap keeps it bounded and the element rules below strip the
 * parts that would have been the reason to worry.
 */
const CONTENT_ROOTS = [
  '.job-post-container',
  '.posting-page',
  '[data-qa="job-description"]',
  'main',
  'article',
  '[role="main"]',
  'body',
]

/**
 * Elements removed wholesale from the captured subtree.
 *
 * Two groups, for two reasons. `form`, `input`, `textarea`, `select` and
 * `option` are the user's own data. The rest — scripts, styles, media, frames —
 * are bulk that no parser reads and that would spend the byte cap on nothing.
 */
const DROP_ELEMENTS = [
  'form',
  'input',
  'textarea',
  'select',
  'option',
  'button',
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'video',
  'audio',
  'picture',
  'source',
  'link',
]

/** Head elements kept verbatim, because the adapters read them. */
const KEEP_HEAD = [
  'title',
  'script[type="application/ld+json"]',
  'meta[property^="og:"]',
  'meta[name^="og:"]',
  'meta[name^="twitter:"]',
  'meta[name="description"]',
]

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Strips presentation and behaviour attributes from a cloned subtree.
 *
 * Class and id survive on purpose — they are what the DOM tier selects on, so
 * removing them would make a snapshot unparseable by the very adapter that
 * captured it. `style` and `on*` go because a snapshot is inert data that may
 * later be rendered somewhere for a human to read, and neither is worth the
 * bytes regardless.
 */
function scrub(root: Element): void {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const name of [...element.getAttributeNames()]) {
      if (name === 'style' || name.startsWith('on')) element.removeAttribute(name)
    }
  }
}

function contentHtml(document: Document): string {
  for (const selector of CONTENT_ROOTS) {
    const found = document.querySelector(selector)
    if (!found) continue

    const clone = found.cloneNode(true) as Element
    for (const doomed of clone.querySelectorAll(DROP_ELEMENTS.join(','))) {
      doomed.remove()
    }
    scrub(clone)

    return clone.outerHTML
  }

  return ''
}

function headHtml(document: Document): string {
  const seen = new Set<Element>()
  const parts: string[] = []

  for (const selector of KEEP_HEAD) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element)) continue
      seen.add(element)
      parts.push(element.outerHTML)
    }
  }

  return parts.join('')
}

export interface TrimmedSnapshot {
  trimmedSource: string
  truncated: boolean
}

/**
 * Builds the stored snapshot for a page.
 *
 * Over the cap, the content subtree is cut and a marker is stored rather than
 * the snapshot being dropped — decision 6 is explicit that a truncated capture
 * beats no capture, because most of what a re-parse needs is near the top of the
 * posting. The head fragment is never cut: it is small, and it is where the
 * JSON-LD lives.
 */
const MARKER = '<!-- JourneyTracker: truncated at the snapshot size cap -->'

/**
 * Shrinks `text` until the document built around it fits the cap.
 *
 * Cutting by characters against a byte budget is deliberately conservative: a
 * UTF-8 character is at least one byte, so slicing to the byte budget can only
 * ever come in under it. The loop then trims the last few multi-byte characters
 * if it did not.
 */
function fitTo(text: string, build: (inner: string) => string): string {
  const room = SNAPSHOT_CAP_BYTES - byteLength(build(''))

  let cut = text.slice(0, Math.max(0, room))
  while (cut && byteLength(build(cut)) > SNAPSHOT_CAP_BYTES) {
    cut = cut.slice(0, Math.floor(cut.length * 0.95))
  }

  return cut
}

export function buildSnapshot(document: Document): TrimmedSnapshot {
  const head = headHtml(document)
  const body = contentHtml(document)

  const wrap = (keptHead: string, inner: string, marker: string) =>
    `<!doctype html><html><head>${keptHead}</head><body>${inner}${marker}</body></html>`

  const full = wrap(head, body, '')
  if (byteLength(full) <= SNAPSHOT_CAP_BYTES)
    return { trimmedSource: full, truncated: false }

  const bodyCut = fitTo(body, (inner) => wrap(head, inner, MARKER))
  if (byteLength(wrap(head, bodyCut, MARKER)) <= SNAPSHOT_CAP_BYTES) {
    return { trimmedSource: wrap(head, bodyCut, MARKER), truncated: true }
  }

  // The head alone busts the cap. Every JSON-LD block on the page is kept
  // verbatim, and a board that inlines its whole listing as JSON-LD can push
  // that past 256KB on its own — at which point cutting the body reaches zero
  // and the document is still over. Without this branch the result was a
  // snapshot that *exceeded* the cap, which `sanitizeReport` then discarded
  // entirely: no snapshot, no `truncated` marker, and no way to tell afterwards
  // that anything had been dropped. The docstring above promises the opposite,
  // and decision 6 is explicit that a cut capture beats none.
  //
  // So the head is cut too. What survives is the front of it, which is where
  // `<title>` and the first JSON-LD block sit — the two things a re-parse most
  // wants.
  const headCut = fitTo(head, (kept) => wrap(kept, '', MARKER))

  return { trimmedSource: wrap(headCut, '', MARKER), truncated: true }
}
