import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runCancellableBenchmark } from './conversation-context-benchmark-cancel'

async function requestCancel(path: string) {
  await writeFile(`${path}.pending`, String(Number(process.hrtime.bigint()) / 1e6))
  await rename(`${path}.pending`, path)
}
it('announces the operation boundary before invoking work and waits for cancellation cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cancel-benchmark-'))
  const path = join(dir, 'cancel')
  const order: string[] = []
  let cleaned = false
  try {
    const result = await runCancellableBenchmark({
      cancelPath: path,
      start: async (signal) => {
        order.push('work')
        try {
          await delay(10000, undefined, { signal })
        } finally {
          cleaned = true
        }
      },
      notifyStarted: () => {
        order.push('marker')
        void requestCancel(path)
      },
      verifyCleanup: () => cleaned
    })
    expect(result).toMatchObject({
      status: 'cancelled',
      cancellation: { activeAtDeadline: true, newDispatchStopped: true, cleanupVerified: true }
    })
    expect(result.cancellation?.observedMs).toBeGreaterThanOrEqual(0)
    expect(order).toEqual(['marker', 'work'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('includes an initial synchronous stall in cancellation observation latency', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cancel-first-stall-'))
  const path = join(dir, 'cancel')
  try {
    const result = await runCancellableBenchmark({
      cancelPath: path,
      start: async (signal) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)
        await delay(10000, undefined, { signal })
      },
      notifyStarted: () => {
        void requestCancel(path)
      },
      verifyCleanup: () => true
    })
    expect(result.status).toBe('cancelled')
    expect(result.cancellation?.observedMs).toBeGreaterThan(250)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('does not classify already completed work as cancelled', async () => {
  const result = await runCancellableBenchmark({
    cancelPath: undefined,
    start: async () => ({ integrity: true }),
    notifyStarted: () => {},
    verifyCleanup: () => true
  })
  expect(result.status).toBe('completed')
  expect(result.cancellation).toBeUndefined()
})
it('does not count corruption after the cancel request as a successful cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cancel-corrupt-')),
    path = join(dir, 'cancel')
  try {
    await expect(
      runCancellableBenchmark({
        cancelPath: path,
        start: async (signal) => {
          try {
            await delay(10000, undefined, { signal })
          } catch {
            throw new Error('source corruption')
          }
        },
        notifyStarted: () => {
          void requestCancel(path)
        },
        verifyCleanup: () => true
      })
    ).rejects.toThrow('source corruption')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it.each([false, true])('refuses ignored abort or incomplete cleanup (%s)', async (ignoreAbort) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-cancel-refusal-'))
  const path = join(dir, 'cancel')
  try {
    const result = await runCancellableBenchmark({
      cancelPath: path,
      start: async (signal) => {
        try {
          await delay(10000, undefined, { signal })
        } catch (error) {
          if (!ignoreAbort) {
            throw error
          }
        }
      },
      notifyStarted: () => {
        void requestCancel(path)
      },
      verifyCleanup: () => false
    })
    expect(result.status).toBe('failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
