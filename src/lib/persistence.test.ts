import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStorageProtection, requestPersistence } from './persistence'

/**
 * Two things are under test here. The *combination* — either defence alone is
 * sufficient per Chrome's storage guide, and a fresh extension routinely fails
 * `persist()` while being perfectly safe under `unlimitedStorage`, so warning on
 * the wrong signal would train the user to ignore the one warning that matters.
 *
 * And the *shape of the environment*. `persist()` is `[Exposed=Window]`, so the
 * service worker sees a StorageManager that has `persisted` and no `persist`.
 * Any stub that supplies both cannot catch a read path that silently gives up
 * in the only context that calls it — which is exactly the bug these gained a
 * `workerContext` option for.
 */
function stubEnvironment(options: {
  unlimitedGranted?: boolean
  manifestPermissions?: string[]
  persisted?: boolean
  persistGrants?: boolean
  noStorageManager?: boolean
  /** Omit `persist()` the way a real service worker does. */
  workerContext?: boolean
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

  const manager: Partial<StorageManager> = {
    persisted: async () => options.persisted ?? false,
  }
  if (!options.workerContext) {
    manager.persist = async () => options.persistGrants ?? false
  }

  vi.stubGlobal('navigator', {
    storage: options.noStorageManager ? undefined : manager,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readStorageProtection', () => {
  it('is eviction-safe on unlimitedStorage alone, even when persist() refuses', async () => {
    stubEnvironment({ unlimitedGranted: true, persisted: false, persistGrants: false })

    const result = await readStorageProtection()

    expect(result.unlimited).toBe(true)
    expect(result.persisted).toBe(false)
    // The case that actually happens on a freshly installed extension.
    expect(result.evictionSafe).toBe(true)
  })

  it('is eviction-safe on already-persisted storage alone', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: true })

    const result = await readStorageProtection()

    expect(result.persisted).toBe(true)
    expect(result.evictionSafe).toBe(true)
  })

  it('is unsafe only when both defences fail', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: false, persistGrants: false })

    expect((await readStorageProtection()).evictionSafe).toBe(false)
  })

  it('reads persisted state in a worker, where persist() does not exist', async () => {
    // The regression: guarding the read on `persist` made this report false on
    // storage Chrome had genuinely marked persistent.
    stubEnvironment({ unlimitedGranted: false, persisted: true, workerContext: true })

    const result = await readStorageProtection()

    expect(result.persisted).toBe(true)
    expect(result.evictionSafe).toBe(true)
  })

  it('never calls persist(), so it is safe to run in a worker', async () => {
    const persist = vi.fn(async () => true)
    stubEnvironment({ unlimitedGranted: false, persisted: false })
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } })

    await readStorageProtection()

    expect(persist).not.toHaveBeenCalled()
  })

  it('falls back to the manifest when the permissions API is unavailable', async () => {
    stubEnvironment({
      manifestPermissions: ['storage', 'unlimitedStorage'],
      persisted: false,
      persistGrants: false,
    })

    expect((await readStorageProtection()).unlimited).toBe(true)
  })

  it('treats a missing StorageManager as a refusal rather than throwing', async () => {
    stubEnvironment({ unlimitedGranted: false, noStorageManager: true })

    const result = await readStorageProtection()

    expect(result.persisted).toBe(false)
    expect(result.evictionSafe).toBe(false)
  })
})

describe('requestPersistence', () => {
  it('asks for persistence and reports a grant', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: false, persistGrants: true })

    expect(await requestPersistence()).toBe(true)
  })

  it('reports a refusal rather than throwing', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: false, persistGrants: false })

    expect(await requestPersistence()).toBe(false)
  })

  it('does not re-request when storage is already persistent', async () => {
    const persist = vi.fn(async () => false)
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ permissions: [] }) } })
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } })

    expect(await requestPersistence()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('degrades to a read where persist() is unavailable', async () => {
    stubEnvironment({ unlimitedGranted: false, persisted: true, workerContext: true })

    expect(await requestPersistence()).toBe(true)
  })
})
