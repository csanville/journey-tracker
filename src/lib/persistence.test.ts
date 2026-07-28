import { afterEach, describe, expect, it, vi } from 'vitest'
import { assessStorageProtection } from './persistence'

/**
 * The point of these is the *combination*: either defence alone is sufficient
 * per Chrome's storage guide, and a fresh extension routinely fails `persist()`
 * while being perfectly safe under `unlimitedStorage`. Warning on the wrong
 * signal would train the user to ignore the one warning that matters.
 */
function stubEnvironment(options: {
  unlimitedGranted?: boolean
  manifestPermissions?: string[]
  persisted?: boolean
  persistGrants?: boolean
  noStorageManager?: boolean
}) {
  vi.stubGlobal('chrome', {
    permissions:
      options.unlimitedGranted === undefined
        ? undefined
        : { contains: async () => options.unlimitedGranted },
    runtime: {
      getManifest: () => ({ permissions: options.manifestPermissions ?? [] }),
    },
  })

  vi.stubGlobal('navigator', {
    storage: options.noStorageManager
      ? undefined
      : {
          persisted: async () => options.persisted ?? false,
          persist: async () => options.persistGrants ?? false,
        },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assessStorageProtection', () => {
  it('is eviction-safe on unlimitedStorage alone, even when persist() refuses', async () => {
    stubEnvironment({ unlimitedGranted: true, persisted: false, persistGrants: false })

    const result = await assessStorageProtection()

    expect(result.unlimited).toBe(true)
    expect(result.persisted).toBe(false)
    // The case that actually happens on a freshly installed extension.
    expect(result.evictionSafe).toBe(true)
  })

  it('is eviction-safe on a granted persist() alone', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: false, persistGrants: true })

    const result = await assessStorageProtection()

    expect(result.evictionSafe).toBe(true)
  })

  it('reports already-persisted storage without re-requesting it', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: true })

    expect((await assessStorageProtection()).persisted).toBe(true)
  })

  it('is unsafe only when both defences fail', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: false, persistGrants: false })

    const result = await assessStorageProtection()

    expect(result.evictionSafe).toBe(false)
  })

  it('falls back to the manifest when the permissions API is unavailable', async () => {
    stubEnvironment({
      manifestPermissions: ['storage', 'unlimitedStorage'],
      persisted: false,
      persistGrants: false,
    })

    expect((await assessStorageProtection()).unlimited).toBe(true)
  })

  it('treats a missing StorageManager as a refusal rather than throwing', async () => {
    stubEnvironment({ unlimitedGranted: false, noStorageManager: true })

    const result = await assessStorageProtection()

    expect(result.persisted).toBe(false)
    expect(result.evictionSafe).toBe(false)
  })
})
