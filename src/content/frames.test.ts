// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://careers-acme.icims.com/jobs/8287/engineer/job" }
import { beforeEach, describe, expect, it } from 'vitest'
import { readableDocuments } from './frames'

/**
 * These use real jsdom frames rather than stubbed objects wherever they can.
 * The whole claim of this module is about what `contentDocument` hands back, so
 * a test that hands it back itself would be asserting its own setup.
 */
function addFrame(html: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  document.body.append(frame)

  const inner = frame.contentDocument
  if (!inner) throw new Error('jsdom gave this frame no document')
  inner.body.innerHTML = html

  return frame
}

/**
 * Gives a frame an address without navigating it.
 *
 * Assigning `frame.src` is the obvious way and it is a trap: jsdom acts on the
 * assignment, replaces the frame's document with a fresh empty one, and throws
 * away the markup the test just wrote into it. The frame is then skipped for
 * having an empty body — so the refusal test passes with the refusal deleted,
 * which is how the first version of it was written and how the seen-to-fail
 * check caught it.
 */
function giveFrameAnAddress(frame: HTMLIFrameElement, href: string): void {
  Object.defineProperty(frame, 'src', { get: () => href })
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('readableDocuments', () => {
  it('is just the page when there are no frames', () => {
    document.body.innerHTML = '<h1>a posting</h1>'

    expect(readableDocuments(document)).toEqual([document])
  })

  it('puts the page first and the frame after it', () => {
    const frame = addFrame('<h1>the posting</h1>')

    // Order is load-bearing, not incidental: `readPage` takes the first read
    // worth offering, so this is what keeps the document the user is looking at
    // able to answer before any frame does.
    expect(readableDocuments(document)).toEqual([document, frame.contentDocument])
  })

  it('skips a frame with an empty body', () => {
    // `about:blank` inherits the parent's origin, so an empty frame is readable
    // rather than refused — every page with a tracking pixel or an ad slot has
    // one, and parsing each would cost a full extraction to learn it is blank.
    addFrame('')

    expect(readableDocuments(document)).toEqual([document])
  })

  it('skips a cross-origin frame, which is what an embed on a careers site is', () => {
    const frame = addFrame('<h1>unreachable</h1>')
    Object.defineProperty(frame, 'contentDocument', { get: () => null })

    expect(readableDocuments(document)).toEqual([document])
  })

  it('survives a frame whose document access throws', () => {
    const frame = addFrame('<h1>unreachable</h1>')
    Object.defineProperty(frame, 'contentDocument', {
      get: () => {
        throw new Error('SecurityError')
      },
    })

    // The extension must never break a job board, and a throw here would take
    // the whole read down rather than one frame of it.
    expect(readableDocuments(document)).toEqual([document])
  })

  /**
   * The destination guard, asserted on a frame no board is known to build.
   *
   * `capture` refuses an application flow by its URL, before it touches the
   * document — and that URL is the *top* one. A posting page holding a frame
   * whose address is an application would walk past it, which is the shape
   * phase 12 hit three times. Workday, the only board `flows.ts` has patterns
   * for, navigates into its flow in the same document, so the existing refusal
   * fires there and this one is unreachable today. It is written for the day a
   * board embeds the form instead.
   */
  it('refuses a frame that is an application flow, however it got there', () => {
    const frame = addFrame('<h1>Voluntary self-identification</h1>')
    giveFrameAnAddress(
      frame,
      'https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/SF/Engineer_R1/apply/1',
    )

    expect(readableDocuments(document)).toEqual([document])
  })

  it('reads a frame whose URL is an ordinary posting', () => {
    // The other half, and the one that fails silently: an over-broad refusal
    // does not break anything visible, it just stops the extension working.
    const frame = addFrame('<h1>Staff Engineer</h1>')
    giveFrameAnAddress(frame, 'https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/SF/E_R1')

    expect(readableDocuments(document)).toContain(frame.contentDocument)
  })

  it('stops after eight same-origin frames', () => {
    for (let index = 0; index < 12; index++) addFrame(`<h1>frame ${index}</h1>`)

    // The page plus the cap. A page with a hundred frames should cost a hundred
    // property reads, not a hundred parses.
    expect(readableDocuments(document)).toHaveLength(9)
  })

  it('does not spend the cap on frames it cannot read', () => {
    for (let index = 0; index < 10; index++) {
      const frame = addFrame(`<h1>blocked ${index}</h1>`)
      Object.defineProperty(frame, 'contentDocument', { get: () => null })
    }
    const wanted = addFrame('<h1>the posting</h1>')

    // Counting refused frames against the cap would let a page of ad iframes
    // push the posting's own frame out of range — the failure this ordering is
    // arranged to avoid.
    expect(readableDocuments(document)).toContain(wanted.contentDocument)
  })
})
