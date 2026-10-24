import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

export const CONVERSATION_LOOP_MEASUREMENT_VERSION = 2
export const CONVERSATION_LOOP_MINIMUM_SAMPLES = 100

/** Histogram startup can miss a synchronous first segment; the heartbeat covers both edges. */
export function startBenchmarkLoopMeasurement() {
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  const started = performance.now()
  let previous = started
  let maximum = 0
  let first = null
  let samples = 0
  let result
  const observe = () => {
    const now = performance.now()
    const interval = now - previous
    first ??= interval
    maximum = Math.max(maximum, interval)
    previous = now
    samples++
    return interval
  }
  histogram.enable()
  const timer = setInterval(observe, 1)
  timer.unref()
  return () => {
    if (result) {
      return result
    }
    const heartbeatTerminalMs = observe()
    clearInterval(timer)
    histogram.disable()
    const loopSamples = histogram.count
    const histogramMaxMs = loopSamples ? histogram.max / 1e6 : null
    result = {
      loopMeasurementVersion: CONVERSATION_LOOP_MEASUREMENT_VERSION,
      loopWindowMs: previous - started,
      loopP95Ms: loopSamples ? histogram.percentile(95) / 1e6 : null,
      loopP99Ms: loopSamples ? histogram.percentile(99) / 1e6 : null,
      histogramMaxMs,
      loopMaxMs: Math.max(histogramMaxMs ?? 0, maximum),
      loopSamples,
      heartbeatMaxMs: maximum,
      heartbeatFirstMs: first,
      heartbeatTerminalMs,
      heartbeatSamples: samples
    }
    return result
  }
}
