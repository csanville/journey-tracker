import { describe, expect, it } from 'vitest'
import { runLadder } from './ladder'

/**
 * The waits are collected rather than slept through, so these assert the
 * *schedule* — which rungs run, and in what order — without spending seconds.
 */
function harness(attempts: (() => Promise<boolean>)[]) {
  const waited: number[] = []
  let index = 0

  return {
    waited,
    get used() {
      return index
    },
    options: {
      attempt: () => attempts[index++]!(),
      stillWanted: () => true,
      delays: [250, 900, 2500],
      wait: async (ms: number) => {
        waited.push(ms)
      },
    },
  }
}

const ok = () => Promise.resolve(true)
const nothing = () => Promise.resolve(false)
const slowNothing = () =>
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))

describe('runLadder', () => {
  it('stops at the first rung that finds something', async () => {
    const run = harness([ok, ok, ok])

    expect(await runLadder(run.options)).toBe(true)
    expect(run.used).toBe(1)
    expect(run.waited).toEqual([250])
  })

  it('climbs every rung when the page keeps saying nothing', async () => {
    const run = harness([nothing, nothing, nothing])

    expect(await runLadder(run.options)).toBe(false)
    expect(run.used).toBe(3)
    expect(run.waited).toEqual([250, 900, 2500])
  })

  it('does not lose a rung to an attempt that was still in flight', async () => {
    // The bug this replaced: the rungs were independent timers with an
    // `inFlight` guard, so a slow first attempt — which is what a cold service
    // worker produces, since `send` retries four times — meant the second rung
    // fired, saw the guard, and was consumed doing nothing. Three attempts
    // became two in exactly the case the retries exist for.
    const run = harness([slowNothing, slowNothing, ok])

    expect(await runLadder(run.options)).toBe(true)
    expect(run.used).toBe(3)
  })

  it('keeps climbing after an attempt throws', async () => {
    const boom = () => Promise.reject(new Error('worker asleep'))
    const run = harness([boom, ok, ok])

    expect(await runLadder(run.options)).toBe(true)
    expect(run.used).toBe(2)
  })

  it('gives up as soon as a newer navigation supersedes it', async () => {
    let wanted = true
    const run = harness([nothing, nothing, nothing])

    const result = await runLadder({
      ...run.options,
      attempt: () => {
        wanted = false
        return run.options.attempt()
      },
      stillWanted: () => wanted,
    })

    expect(result).toBe(false)
    // One attempt ran, and the ladder stopped rather than reporting about a
    // page the tab has already left.
    expect(run.used).toBe(1)
    expect(run.waited).toEqual([250])
  })

  it('does not attempt at all when superseded before the first rung', async () => {
    const run = harness([ok, ok, ok])

    expect(await runLadder({ ...run.options, stillWanted: () => false })).toBe(false)
    expect(run.used).toBe(0)
  })
})
