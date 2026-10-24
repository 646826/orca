import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Parent writes cancellation after the child announces a started operation. Poll delay is
 * included in observation latency; CPU starvation therefore cannot masquerade as prompt cancellation. */
export async function runCancellableBenchmark<T>(input: {
  cancelPath?: string
  start(signal: AbortSignal): Promise<T>
  notifyStarted(): void
  verifyCleanup(): boolean | Promise<boolean>
}) {
  const controller = new AbortController()
  let settled = false,
    requestedAt: number | null = null,
    observedAt: number | null = null
  let pollFailure: unknown
  input.notifyStarted()
  const pending = input.start(controller.signal)
  const poll = (async () => {
    while (!settled && input.cancelPath) {
      try {
        const timestamp = Number(await readFile(input.cancelPath, 'utf8'))
        if (!Number.isFinite(timestamp) || timestamp <= 0) {
          throw new Error('Invalid parent cancellation timestamp')
        }
        if (!settled) {
          requestedAt = timestamp
          observedAt = Number(process.hrtime.bigint()) / 1e6
          controller.abort(new DOMException('Benchmark parent cancelled', 'AbortError'))
        }
        return
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          pollFailure = error
          controller.abort(error)
          return
        }
      }
      await delay(2)
    }
  })()
  try {
    const value = await pending
    if (controller.signal.aborted) {
      return { status: 'failed', reason: 'Operation ignored cancellation' }
    }
    return { status: 'completed', value }
  } catch (error) {
    if (pollFailure) {
      throw pollFailure
    }
    if (
      !controller.signal.aborted ||
      requestedAt === null ||
      observedAt === null ||
      !(error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
    const cleanupVerified = await input.verifyCleanup()
    const endedAt = Number(process.hrtime.bigint()) / 1e6
    return {
      status: cleanupVerified ? 'cancelled' : 'failed',
      cancellation: {
        activeAtDeadline: true,
        observedMs: observedAt - requestedAt,
        unwindMs: endedAt - requestedAt,
        newDispatchStopped: cleanupVerified,
        cleanupVerified,
        scope:
          'No new journal dispatch and no transient export read pins; retained completed artifacts are not leaks'
      }
    }
  } finally {
    settled = true
    await poll
  }
}
