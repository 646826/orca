import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import {
  CONVERSATION_LOOP_MEASUREMENT_VERSION,
  CONVERSATION_LOOP_MINIMUM_SAMPLES
} from './conversation-context-benchmark-loop.mjs'

const MIB = 1024 * 1024

function hasShortOperationBound(sample) {
  return (
    sample.loopMeasurementVersion === CONVERSATION_LOOP_MEASUREMENT_VERSION &&
    sample.loopWindowMs <= 50 &&
    sample.elapsedMs <= sample.loopWindowMs &&
    sample.heartbeatMaxMs <= 50
  )
}

export const CONVERSATION_BENCHMARK_REQUIRED_LANES = Object.freeze([
  'artifact-100',
  'artifact-1024',
  'artifact-0',
  'export-64',
  'projection-64',
  'projection-1000',
  'projection-10000',
  'projection-100000',
  'cancel-export',
  'cancel-projection',
  'cancel-artifact',
  'history-page-200',
  'activation-retention-100'
])
export function parseConversationBenchmarkArgs(argv) {
  const options = {
    output: null,
    baselineRoot: null,
    runs: 10,
    warmups: 3,
    check: false,
    canonical: false,
    cancellation: false,
    events: [],
    preparations: [],
    projections: [],
    tiers: [0, 100, 1024]
  }
  const flags = {
    '--output': 'output',
    '--baseline-root': 'baselineRoot',
    '--runs': 'runs',
    '--warmups': 'warmups',
    '--tiers': 'tiers',
    '--events': 'events',
    '--preparations': 'preparations',
    '--projections': 'projections'
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--') {
      continue
    }
    if (flag === '--canonical' || flag === '--cancellation') {
      options[flag === '--canonical' ? 'canonical' : 'cancellation'] = true
      continue
    }
    if (flag === '--check') {
      options.check = true
      continue
    }
    const key = flags[flag]
    const value = argv[++index]
    if (!key || !value || value.startsWith('--')) {
      throw new Error(`Invalid benchmark option: ${flag}`)
    }
    options[key] =
      key === 'runs' || key === 'warmups'
        ? Number(value)
        : key === 'tiers' || key === 'events' || key === 'preparations' || key === 'projections'
          ? value.split(',').map(Number)
          : value
  }
  if (options.runs !== 10 || options.warmups !== 3) {
    throw new Error('T37 requires three warmups and ten measured runs')
  }
  if (
    new Set(options.events).size !== options.events.length ||
    options.events.some((count) => ![1000, 10000, 100000].includes(count))
  ) {
    throw new Error('Journal event counts must be distinct values from 1000,10000,100000')
  }
  if (
    new Set(options.preparations).size !== options.preparations.length ||
    options.preparations.some((count) => ![1000, 10000, 100000].includes(count))
  ) {
    throw new Error('Preparation event counts must be distinct values from 1000,10000,100000')
  }
  if (
    new Set(options.projections).size !== options.projections.length ||
    options.projections.some((count) => ![1000, 10000, 100000].includes(count))
  ) {
    throw new Error('Projection event counts must be distinct values from 1000,10000,100000')
  }
  if (
    !options.tiers.length ||
    new Set(options.tiers).size !== options.tiers.length ||
    options.tiers.some((tier) => ![0, 100, 1024].includes(tier))
  ) {
    throw new Error('Artifact tiers must be distinct values from 0,100,1024')
  }
  return options
}

export function evaluateConversationBenchmark(report) {
  const failures = [],
    incomplete = [],
    summaries = [],
    peaks = new Map()
  if (!report.sourceBefore || report.sourceBefore !== report.sourceAfter) {
    failures.push('Source changed during benchmark')
  }
  if (!report.lanes.length) {
    incomplete.push('No measured workloads')
  }
  const names = new Set(report.lanes.map((lane) => lane.name))
  if (names.size !== report.lanes.length) {
    failures.push('Duplicate workload results')
  }
  for (const name of CONVERSATION_BENCHMARK_REQUIRED_LANES) {
    if (!names.has(name)) {
      incomplete.push(`${name}: not run`)
    }
  }
  for (const lane of report.lanes) {
    const baseline =
      lane.name.startsWith('baseline-artifact-') || lane.name.startsWith('baseline-journal-')
    if (lane.warmups.length !== 3 || lane.samples.length !== 10) {
      incomplete.push(`${lane.name}: insufficient samples`)
    }
    const valid = []
    for (const sample of [...lane.warmups, ...lane.samples]) {
      if (
        sample.status === 'infrastructure-timeout' ||
        sample.status === 'infrastructure-termination-unknown'
      ) {
        incomplete.push(
          `${lane.name}: ${sample.status === 'infrastructure-timeout' ? 'child watchdog expired' : 'child termination unverified'} (${sample.lastPhase ?? 'unknown phase'})`
        )
        continue
      }
      const cancellation = lane.name.startsWith('cancel-')
      if (
        cancellation &&
        (sample.status !== 'cancelled' ||
          sample.cancellation?.activeAtDeadline !== true ||
          sample.cancellation?.newDispatchStopped !== true ||
          sample.cancellation?.cleanupVerified !== true)
      ) {
        failures.push(`${lane.name}: cancellation not established`)
        continue
      }
      if (sample.status === 'capacity-refused') {
        incomplete.push(`${lane.name}: capacity-refused (${(sample.reasons ?? []).join(', ')})`)
        continue
      }
      if (!cancellation && (sample.status !== 'completed' || sample.integrity !== true)) {
        failures.push(`${lane.name}: workload or integrity failed (${sample.status})`)
        continue
      }
      const metrics = ['elapsedMs', 'idleRssBytes', 'peakRssBytes']
      if (metrics.some((key) => !Number.isFinite(sample[key]) || sample[key] < 0)) {
        failures.push(`${lane.name}: invalid measurements`)
        continue
      }
      const currentMeasurement =
        sample.loopMeasurementVersion === CONVERSATION_LOOP_MEASUREMENT_VERSION
      if (!currentMeasurement && !baseline) {
        incomplete.push(`${lane.name}: legacy or missing event-loop measurement version`)
      }
      if (
        currentMeasurement &&
        (!Number.isInteger(sample.loopSamples) ||
          sample.loopSamples < 0 ||
          !Number.isInteger(sample.heartbeatSamples) ||
          sample.heartbeatSamples < 1 ||
          [
            'loopWindowMs',
            'heartbeatMaxMs',
            'heartbeatFirstMs',
            'heartbeatTerminalMs',
            'loopMaxMs'
          ].some((key) => !Number.isFinite(sample[key]) || sample[key] < 0) ||
          sample.loopWindowMs < sample.elapsedMs ||
          sample.heartbeatMaxMs > sample.loopWindowMs ||
          sample.heartbeatFirstMs > sample.heartbeatMaxMs ||
          sample.heartbeatTerminalMs > sample.heartbeatMaxMs)
      ) {
        failures.push(`${lane.name}: invalid event-loop measurements`)
        continue
      }
      const histogramMetrics = ['loopP95Ms', 'loopP99Ms', 'histogramMaxMs']
      if (
        currentMeasurement && sample.loopSamples === 0
          ? histogramMetrics.some((key) => sample[key] !== null)
          : (currentMeasurement ? histogramMetrics : histogramMetrics.slice(0, 2)).some(
              (key) => !Number.isFinite(sample[key]) || sample[key] < 0
            )
      ) {
        failures.push(`${lane.name}: invalid histogram measurements`)
        continue
      }
      if (
        !baseline &&
        currentMeasurement &&
        sample.loopSamples < CONVERSATION_LOOP_MINIMUM_SAMPLES &&
        !hasShortOperationBound(sample)
      ) {
        incomplete.push(
          `${lane.name}: insufficient in-operation histogram observations (${sample.loopSamples ?? 'missing'}/${CONVERSATION_LOOP_MINIMUM_SAMPLES})`
        )
      }
      const increment = Math.max(0, sample.peakRssBytes - sample.idleRssBytes)
      if (!baseline && increment > 128 * MIB) {
        failures.push(`${lane.name}: memory budget exceeded`)
      }
      if (!baseline && (sample.loopP95Ms > 50 || sample.loopP99Ms > 100)) {
        failures.push(`${lane.name}: event-loop budget exceeded`)
      }
      if (!baseline && sample.heartbeatMaxMs > 100) {
        failures.push(`${lane.name}: event-loop maximum-stall guard exceeded (100ms)`)
      }
      if (
        (cancellation || sample.cancellation) &&
        (!sample.cancellation ||
          !Number.isFinite(sample.cancellation.observedMs) ||
          sample.cancellation.observedMs < 0 ||
          sample.cancellation.observedMs > 250 ||
          !Number.isFinite(sample.cancellation.unwindMs) ||
          sample.cancellation.unwindMs < 0 ||
          sample.cancellation.unwindMs > 1000)
      ) {
        failures.push(`${lane.name}: cancellation deadline exceeded`)
      }
      if (
        lane.name === 'history-page-200' &&
        (!Number.isFinite(sample.warmPageP95Ms) ||
          sample.warmPageP95Ms < 0 ||
          sample.warmPageP95Ms > 200 ||
          !Number.isFinite(sample.baselineWarmPageP95Ms) ||
          sample.baselineWarmPageP95Ms <= 0 ||
          sample.warmPageP95Ms > 1.2 * sample.baselineWarmPageP95Ms ||
          !Number.isFinite(sample.coldPageMs) ||
          sample.coldPageMs < 0 ||
          sample.coldPageMs > 1000 ||
          sample.virtualizationBounded !== true)
      ) {
        failures.push(`${lane.name}: paging verification failed`)
      }
      if (
        lane.name === 'activation-retention-100' &&
        (sample.activations !== 100 ||
          sample.queueSettled !== true ||
          sample.equivalentGcConditions !== true ||
          !Number.isFinite(sample.retainedHeapGrowthBytes) ||
          sample.retainedHeapGrowthBytes < 0 ||
          sample.retainedHeapGrowthBytes > 32 * MIB)
      ) {
        failures.push(`${lane.name}: retention verification failed`)
      }
      if (lane.samples.includes(sample)) {
        valid.push(sample)
      }
    }
    if (valid.length) {
      const histogramSamples = valid.filter((sample) => Number.isFinite(sample.loopP99Ms))
      const heartbeatSamples = valid.filter((sample) => Number.isFinite(sample.heartbeatMaxMs))
      const peakIncrementBytes = Math.max(
        ...valid.map((sample) => Math.max(0, sample.peakRssBytes - sample.idleRssBytes))
      )
      peaks.set(lane.name, peakIncrementBytes)
      summaries.push({
        name: lane.name,
        elapsed: summarizeBenchmarkSamples(valid.map((sample) => sample.elapsedMs)),
        peakIncrementBytes,
        worstLoopP95Ms: histogramSamples.length
          ? Math.max(...histogramSamples.map((sample) => sample.loopP95Ms))
          : null,
        worstLoopP99Ms: histogramSamples.length
          ? Math.max(...histogramSamples.map((sample) => sample.loopP99Ms))
          : null,
        histogramSufficientSamples: valid.filter(
          (sample) =>
            sample.loopMeasurementVersion === CONVERSATION_LOOP_MEASUREMENT_VERSION &&
            sample.loopSamples >= CONVERSATION_LOOP_MINIMUM_SAMPLES
        ).length,
        shortOperationBoundSamples: baseline
          ? 0
          : valid.filter(
              (sample) =>
                sample.loopSamples < CONVERSATION_LOOP_MINIMUM_SAMPLES &&
                hasShortOperationBound(sample)
            ).length,
        insufficientHistogramSamples: valid.filter(
          (sample) =>
            sample.loopMeasurementVersion !== CONVERSATION_LOOP_MEASUREMENT_VERSION ||
            sample.loopSamples < CONVERSATION_LOOP_MINIMUM_SAMPLES
        ).length,
        insufficientResponsivenessSamples: baseline
          ? null
          : valid.filter(
              (sample) =>
                sample.loopMeasurementVersion !== CONVERSATION_LOOP_MEASUREMENT_VERSION ||
                (sample.loopSamples < CONVERSATION_LOOP_MINIMUM_SAMPLES &&
                  !hasShortOperationBound(sample))
            ).length,
        eventLoopAcceptance: baseline ? 'diagnostic-only' : 'histogram-or-whole-operation-bound',
        worstHeartbeatMaxMs: heartbeatSamples.length
          ? Math.max(...heartbeatSamples.map((sample) => sample.heartbeatMaxMs))
          : null
      })
    }
  }
  if (
    peaks.has('artifact-100') &&
    peaks.has('artifact-1024') &&
    peaks.get('artifact-1024') - peaks.get('artifact-100') > 32 * MIB
  ) {
    failures.push('Artifact tier memory growth exceeded')
  }
  for (const lane of report.deferred) {
    incomplete.push(`${lane.name}: ${lane.reason}`)
  }
  return {
    status: failures.length ? 'failed' : incomplete.length ? 'incomplete' : 'passed',
    failures,
    incomplete,
    summaries
  }
}
