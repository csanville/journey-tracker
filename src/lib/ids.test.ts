import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from './ids'

/** RFC 4122 v4: version nibble `4`, variant nibble one of 8, 9, a, b. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('produces a v4 uuid', () => {
    expect(newId()).toMatch(UUID_V4)
  })

  it('produces a v4 uuid where randomUUID does not exist', () => {
    // The case `activeTab` capture introduced. `crypto.randomUUID` is exposed
    // only in a secure context, and the injected bundle runs on whatever page
    // the user right-clicked — including the `http://` careers pages that are
    // exactly the long tail this feature is for. Every context before phase 5
    // was secure, so this was unreachable until it was not.
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })

    expect(newId()).toMatch(UUID_V4)
  })

  it('does not repeat itself on the fallback path', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })

    const ids = new Set(Array.from({ length: 500 }, newId))

    expect(ids.size).toBe(500)
  })

  it('does not throw where a secure context is missing', () => {
    // The failure this replaced was not a bad id, it was an exception — thrown
    // inside a ladder rung that swallows failures, so the page reported nothing
    // and the panel said no posting was detected.
    vi.stubGlobal('crypto', {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    })

    expect(() => newId()).not.toThrow()
  })
})
