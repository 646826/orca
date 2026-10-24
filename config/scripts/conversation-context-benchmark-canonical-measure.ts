import { performance } from 'node:perf_hooks'
import { readdir, rm } from 'node:fs/promises'
import { createCanonicalBenchmark } from './conversation-context-benchmark-canonical'
import { runCancellableBenchmark } from './conversation-context-benchmark-cancel'
import { startBenchmarkLoopMeasurement } from './conversation-context-benchmark-loop.mjs'
import { benchmarkPhase } from './conversation-context-benchmark-process.mjs'
import { ConversationExportError } from '../../src/main/native-chat/conversations/conversation-export-error'
import { ConversationPreparationRowsRefusal } from '../../src/main/native-chat/conversations/conversation-preparation-rows'

export async function measureCanonicalBenchmark(request: {
  stateDirectory: string
  lane: 'export' | 'projection' | 'cancel-export' | 'cancel-projection'
  cancelPath?: string
}) {
  const setupStarted = performance.now()
  benchmarkPhase('setup-start')
  const fixture = await createCanonicalBenchmark(request.stateDirectory, 64 * 1024 * 1024)
  let stopLoopMeasurement: ReturnType<typeof startBenchmarkLoopMeasurement> | undefined
  try {
    const idleRssBytes = process.memoryUsage().rss,
      setupPeakRssBytes = process.resourceUsage().maxRSS * 1024
    const setupElapsedMs = performance.now() - setupStarted
    benchmarkPhase('setup-end')
    stopLoopMeasurement = startBenchmarkLoopMeasurement()
    const started = performance.now(),
      dispatches = fixture.dispatchCount()
    let claimsAtAbort = fixture.claimCount()
    const result = await runCancellableBenchmark({
      cancelPath: request.cancelPath,
      start: async (signal) => {
        signal.addEventListener(
          'abort',
          () => {
            claimsAtAbort = fixture.claimCount()
          },
          { once: true }
        )
        try {
          return await fixture.run(
            request.lane.endsWith('projection') ? 'projection' : 'export',
            signal
          )
        } catch (error) {
          if (
            (error instanceof ConversationExportError && error.code === 'resource-limit') ||
            (error instanceof ConversationPreparationRowsRefusal &&
              error.message === 'resource-limit')
          ) {
            return { status: 'capacity-refused', integrity: false, reasons: ['resource-limit'] }
          }
          throw error
        }
      },
      notifyStarted: () => {
        if (request.cancelPath) {
          process.stderr.write('ORCA_BENCHMARK_STARTED\n')
        }
      },
      verifyCleanup: async () =>
        fixture.claimCount() === claimsAtAbort &&
        fixture.transientPins() === 0 &&
        fixture.dispatchCount() === dispatches &&
        !(await readdir(request.stateDirectory)).some((name) =>
          name.startsWith('.conversation-export-')
        )
    })
    const elapsedMs = performance.now() - started
    const loopMeasurement = stopLoopMeasurement()
    benchmarkPhase('operation-end')
    return {
      ...(result.status === 'completed' ? result.value : result),
      elapsedMs,
      setupElapsedMs,
      idleRssBytes,
      setupPeakRssBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      ...loopMeasurement,
      nativeAcceptance: 'not-run',
      toolByteLength: 64 * 1024 * 1024
    }
  } finally {
    stopLoopMeasurement?.()
    fixture.close()
    await rm(request.stateDirectory, { recursive: true, force: true })
    benchmarkPhase('cleanup-end')
  }
}
