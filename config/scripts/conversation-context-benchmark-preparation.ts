import { performance } from 'node:perf_hooks'
import { rm } from 'node:fs/promises'
import { startBenchmarkLoopMeasurement } from './conversation-context-benchmark-loop.mjs'
import { createPreparationBenchmarkFixture } from './conversation-context-benchmark-preparation-fixture'
import { benchmarkPhase } from './conversation-context-benchmark-process.mjs'

/** Synthetic target evidence exercises host preparation; no native transport/model is measured. */
export async function measureConversationPreparation(request: {
  stateDirectory: string
  eventCount: number
  policy: 'full' | 'budgeted'
  projection?: 'exact' | 'tools'
}) {
  const setupStarted = performance.now()
  benchmarkPhase('setup-start')
  const fixture = await createPreparationBenchmarkFixture(request)
  try {
    const setupElapsedMs = performance.now() - setupStarted
    const idleRssBytes = process.memoryUsage().rss
    const setupPeakRssBytes = process.resourceUsage().maxRSS * 1024
    const startedAt = new Date().toISOString()
    benchmarkPhase('setup-end')
    const stopLoopMeasurement = startBenchmarkLoopMeasurement()
    const start = performance.now()
    try {
      const result = await fixture.run(new AbortController().signal)
      const elapsedMs = performance.now() - start
      const loopMeasurement = stopLoopMeasurement()
      return {
        ...result,
        elapsedMs,
        setupElapsedMs,
        idleRssBytes,
        setupPeakRssBytes,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        ...loopMeasurement,
        startedAt,
        finishedAt: new Date().toISOString(),
        eventCount: request.eventCount,
        verification:
          'Production freeze/export/compiler/consent/index/save plus independent canonical hash audit; synthetic budget/target only'
      }
    } finally {
      stopLoopMeasurement()
      benchmarkPhase('operation-end')
    }
  } finally {
    fixture.close()
    await rm(request.stateDirectory, { recursive: true, force: true })
    benchmarkPhase('cleanup-end')
  }
}
