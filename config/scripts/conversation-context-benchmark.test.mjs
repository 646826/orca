import { installScratchWorkerFixture } from '../../src/main/native-chat/conversations/conversation-scratch-worker-setup.test-fixture'
import { measureConversationJournal } from './conversation-context-benchmark-journal'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { conversationBenchmarkRows } from './conversation-context-benchmark-rows.mjs'
import {
  isProviderUserMessageEcho,
  journalEchoClaimant
} from '../../src/main/native-chat/agent-session-journal/journal-reducer'
import { startJournalRowFold } from '../../src/main/native-chat/agent-session-journal/journal-open'
import { agentJournalSubmissionKey } from '../../src/shared/agent-session-journal-item-key'
import {
  CONVERSATION_BENCHMARK_REQUIRED_LANES,
  evaluateConversationBenchmark,
  parseConversationBenchmarkArgs
} from './conversation-context-benchmark-report.mjs'
import {
  createBenchmarkArtifact,
  createBenchmarkRunDirectory,
  createSyntheticBenchmarkDisclosure
} from './conversation-context-benchmark-fixtures.mjs'

installScratchWorkerFixture()

it('authorizes only the exact synthetic artifact for the benchmark target and generation', () => {
  const version = {
    uploadId: 'synthetic-upload',
    name: 'evidence',
    sha256: 'a'.repeat(64),
    byteLength: 0
  }
  const disclosure = createSyntheticBenchmarkDisclosure(version)
  expect(disclosure.resolve({ ...version })).toMatchObject({
    version,
    conversationId: 'benchmark',
    contextGeneration: 1,
    targetBindingDigest: disclosure.targetBindingDigest,
    action: 'include'
  })
  for (const changed of [
    { uploadId: 'other' },
    { name: 'other' },
    { sha256: 'b'.repeat(64) },
    { byteLength: 1 }
  ]) {
    expect(disclosure.resolve({ ...version, ...changed })).toBeNull()
  }
  version.sha256 = 'c'.repeat(64)
  expect(disclosure.resolve(version)).toBeNull()
})

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
const sample = (name) => ({
  status: name?.startsWith('cancel-') ? 'cancelled' : 'completed',
  integrity: true,
  elapsedMs: 10,
  idleRssBytes: 100,
  peakRssBytes: 200,
  loopP95Ms: 1,
  loopP99Ms: 2,
  loopMeasurementVersion: 2,
  loopWindowMs: 10,
  loopSamples: 100,
  histogramMaxMs: 3,
  loopMaxMs: 3,
  heartbeatMaxMs: 3,
  heartbeatFirstMs: 1,
  heartbeatTerminalMs: 1,
  heartbeatSamples: 101,
  ...(name?.startsWith('cancel-')
    ? {
        cancellation: {
          observedMs: 10,
          unwindMs: 20,
          activeAtDeadline: true,
          newDispatchStopped: true,
          cleanupVerified: true
        }
      }
    : {}),
  warmPageP95Ms: 10,
  baselineWarmPageP95Ms: 10,
  coldPageMs: 100,
  virtualizationBounded: true,
  activations: 100,
  queueSettled: true,
  equivalentGcConditions: true,
  retainedHeapGrowthBytes: 100
})
const lane = (name) => ({
  name,
  phase: 'warm',
  warmups: Array.from({ length: 3 }, () => sample(name)),
  samples: Array.from({ length: 10 }, () => sample(name))
})
const report = () => ({
  sourceBefore: 'a',
  sourceAfter: 'a',
  lanes: CONVERSATION_BENCHMARK_REQUIRED_LANES.map(lane),
  deferred: []
})

it('does not let missing samples, unavailable lanes or source changes claim a pass', () => {
  expect(evaluateConversationBenchmark(report()).status).toBe('passed')
  const missing = report()
  missing.lanes[0].samples.pop()
  expect(evaluateConversationBenchmark(missing).status).toBe('incomplete')
  const unavailable = report()
  unavailable.deferred.push({ name: 'switches', reason: 'not implemented' })
  expect(evaluateConversationBenchmark(unavailable).status).toBe('incomplete')
  const changed = report()
  changed.sourceAfter = 'b'
  expect(evaluateConversationBenchmark(changed).status).toBe('failed')
})
it('fails on a single outlier or integrity failure, retaining valid samples', () => {
  const value = report()
  value.lanes[0].samples[4].peakRssBytes = 129 * 1024 * 1024
  const result = evaluateConversationBenchmark(value)
  expect(result.status).toBe('failed')
  expect(result.failures.join(' ')).toContain('memory')
  expect(result.summaries[0].elapsed.samples).toBe(10)
  const corrupt = report()
  corrupt.lanes[0].samples[8].integrity = false
  expect(evaluateConversationBenchmark(corrupt).status).toBe('failed')
})
it('does not count refused or nonfinite results as successful workload completion', () => {
  const value = report()
  value.lanes[0].samples[0] = { status: 'refused', reason: 'resource-limit' }
  expect(evaluateConversationBenchmark(value).status).toBe('failed')
  const invalid = report()
  invalid.lanes[0].samples[0].loopP99Ms = Number.NaN
  expect(evaluateConversationBenchmark(invalid).status).toBe('failed')
})
it('rejects negative page durations and retained heap measurements', () => {
  for (const field of ['coldPageMs', 'warmPageP95Ms']) {
    const value = report()
    value.lanes.find((lane) => lane.name === 'history-page-200').samples[0][field] = -1
    expect(evaluateConversationBenchmark(value).status).toBe('failed')
  }
  const value = report()
  value.lanes.find(
    (lane) => lane.name === 'activation-retention-100'
  ).samples[0].retainedHeapGrowthBytes = -1
  expect(evaluateConversationBenchmark(value).status).toBe('failed')
})
it('checks independently measured cancellation and artifact growth without relaxing budgets', () => {
  const value = report()
  value.lanes[0].samples[0].cancellation = { observedMs: 251, unwindMs: 900 }
  expect(evaluateConversationBenchmark(value).status).toBe('failed')
  const growth = report()
  growth.lanes[1].samples = Array.from({ length: 10 }, () => ({
    ...sample(),
    peakRssBytes: 34 * 1024 * 1024
  }))
  expect(evaluateConversationBenchmark(growth).failures.join(' ')).toContain('growth')
})
it('rejects undersampled runs and unknown options before starting workloads', () => {
  expect(() => parseConversationBenchmarkArgs(['--runs', '1'])).toThrow()
  expect(() => parseConversationBenchmarkArgs(['--warmups', '2'])).toThrow()
  expect(() => parseConversationBenchmarkArgs(['--unsafe'])).toThrow()
  expect(parseConversationBenchmarkArgs(['--output', 'test-results/run', '--check'])).toMatchObject(
    { runs: 10, warmups: 3, check: true }
  )
})
it('requires every advertised tier and distinguishes real cancellation from early completion', () => {
  const missing = report()
  missing.lanes.splice(1, 1)
  expect(evaluateConversationBenchmark(missing).status).not.toBe('passed')
  const cancellation = report()
  cancellation.lanes[0].name = 'cancel-export'
  expect(evaluateConversationBenchmark(cancellation).failures.join(' ')).toContain('cancellation')
  const absent = report()
  delete absent.lanes.find((lane) => lane.name === 'cancel-export').samples[0].cancellation
  expect(evaluateConversationBenchmark(absent).status).toBe('failed')
})
it('uses mixed Unicode user, assistant, tool and revision events with distinct user identities', () => {
  expect(parseConversationBenchmarkArgs(['--events', '1000,100000']).events).toEqual([1000, 100000])
  expect(() => parseConversationBenchmarkArgs(['--events', '3'])).toThrow()
  const rows = [...conversationBenchmarkRows(1000, 1)]
  const userEcho = rows.find((row) => row.kind === 'item' && row.body?.role === 'user')
  expect(isProviderUserMessageEcho(userEcho.itemId, userEcho.body)).toBe(true)
  const fold = startJournalRowFold({ sessionId: 'synthetic-session', epoch: 'synthetic' })
  for (const row of rows.slice(0, 3)) {
    expect(fold.add({ seq: row.seq, rowJson: JSON.stringify(row) })).toBe(true)
  }
  expect(journalEchoClaimant(fold.finish().state, userEcho.itemId, userEcho.body)).toBe(
    agentJournalSubmissionKey('send-0')
  )
  expect(rows).toHaveLength(1001)
  expect(rows.filter((row) => row.body?.role === 'user')).toHaveLength(300)
  expect(rows.filter((row) => row.body?.role === 'assistant')).toHaveLength(300)
  expect(rows.filter((row) => row.body?.kind === 'tool-call')).toHaveLength(200)
  expect(rows.filter((row) => row.revision === 2)).toHaveLength(200)
  expect(rows[6].itemId).toBe(rows[7].itemId)
  expect(rows.filter((row) => row.kind === 'submission')).toHaveLength(100)
  expect(rows.filter((row) => row.kind === 'dispatch')).toHaveLength(200)
  expect(JSON.stringify(rows[1])).toContain('日本語🙂')
  expect(() => [...conversationBenchmarkRows(3, 1)]).toThrow()
})
it('never overwrites an existing output directory or unrelated fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-conversation-bench-'))
  roots.push(root)
  const output = join(root, 'run')
  await createBenchmarkRunDirectory(output)
  await writeFile(join(output, 'keep'), 'unchanged')
  await expect(createBenchmarkRunDirectory(output)).rejects.toThrow()
  expect(await readFile(join(output, 'keep'), 'utf8')).toBe('unchanged')
  const artifact = await createBenchmarkArtifact(join(output, 'artifact'), 1025)
  expect(artifact.byteLength).toBe(1025)
  await expect(createBenchmarkArtifact(join(output, 'artifact'), 1)).rejects.toThrow()
  expect((await readFile(artifact.path)).byteLength).toBe(1025)
})

it('measures the real presentation lane with a separate canonical byte audit against the same reducer baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-benchmark-presentation-'))
  roots.push(root)
  const candidate = await measureConversationJournal({
    lane: 'journal',
    stateDirectory: join(root, 'candidate'),
    eventCount: 20
  })
  const baseline = await measureConversationJournal({
    lane: 'baseline-journal',
    stateDirectory: join(root, 'baseline'),
    eventCount: 20
  })
  expect(candidate).toMatchObject({
    status: 'completed',
    integrity: true,
    sourceCount: 21,
    itemCount: 10,
    expectedHash: baseline.expectedHash,
    presentationItemDigest: baseline.presentationItemDigest,
    verification: expect.stringContaining('not full preparation/compiler')
  })
  expect(baseline).toMatchObject({ integrity: true, sourceCount: 21, itemCount: 10 })
})

it('selects current preparation workloads and classifies capacity refusal as incomplete', () => {
  expect(
    parseConversationBenchmarkArgs(['--preparations', '1000,10000,100000']).preparations
  ).toEqual([1000, 10000, 100000])
  expect(() => parseConversationBenchmarkArgs(['--preparations', '7'])).toThrow()
  const result = report()
  const refused = lane('preparation-budgeted-100000')
  refused.samples = refused.samples.map((value) => ({
    ...value,
    status: 'capacity-refused',
    integrity: false,
    reasons: ['resource-limit']
  }))
  result.lanes.push(refused)
  expect(evaluateConversationBenchmark(result).status).toBe('incomplete')
})

it('selects only explicit real projection scales and never passes a capacity or infrastructure refusal', () => {
  expect(
    parseConversationBenchmarkArgs(['--projections', '1000,10000,100000']).projections
  ).toEqual([1000, 10000, 100000])
  expect(() => parseConversationBenchmarkArgs(['--projections', '1000,1000'])).toThrow()
  expect(() => parseConversationBenchmarkArgs(['--projections', '64'])).toThrow()
  for (const status of ['capacity-refused', 'infrastructure-timeout']) {
    const value = report()
    value.lanes.find((entry) => entry.name === 'projection-100000').samples[0] = {
      status,
      integrity: false,
      reasons: ['resource-limit'],
      lastPhase: 'setup-start'
    }
    expect(evaluateConversationBenchmark(value)).toMatchObject({
      status: 'incomplete',
      failures: []
    })
  }
})

it('requires cancellation cleanup evidence rather than only an abort flag', () => {
  const value = report()
  value.lanes.find(
    (entry) => entry.name === 'cancel-export'
  ).samples[0].cancellation.cleanupVerified = false
  expect(evaluateConversationBenchmark(value).status).toBe('failed')
})

it('never passes long sparse or legacy evidence, even when reported percentiles are low', () => {
  for (const count of [0, 1, 99]) {
    const value = report()
    Object.assign(value.lanes[0].samples[0], {
      loopSamples: count,
      elapsedMs: 60,
      loopWindowMs: 60,
      ...(count === 0 ? { loopP95Ms: null, loopP99Ms: null, histogramMaxMs: null } : {})
    })
    const result = evaluateConversationBenchmark(value)
    expect(result.status).toBe('incomplete')
    expect(result.incomplete.join(' ')).toContain('insufficient in-operation histogram')
  }
  const legacy = report()
  delete legacy.lanes[0].samples[0].loopMeasurementVersion
  expect(evaluateConversationBenchmark(legacy).status).toBe('incomplete')
})

it('fails a first synchronous stall independently of sparse histogram evidence', () => {
  const value = report()
  Object.assign(value.lanes[0].samples[0], {
    loopSamples: 0,
    loopP95Ms: null,
    loopP99Ms: null,
    histogramMaxMs: null,
    heartbeatFirstMs: 1138,
    heartbeatTerminalMs: 1138,
    heartbeatMaxMs: 1138,
    loopMaxMs: 1138,
    heartbeatSamples: 1,
    loopWindowMs: 1138
  })
  const result = evaluateConversationBenchmark(value)
  expect(result.status).toBe('failed')
  expect(result.failures.join(' ')).toContain('maximum-stall guard')
  expect(result.incomplete.join(' ')).toContain('insufficient in-operation histogram')
})

it('checks cancellation deadlines even when the operation is too short for histogram p99', () => {
  const value = report()
  const cancellation = value.lanes.find((entry) => entry.name === 'cancel-export').samples[0]
  cancellation.loopSamples = 3
  cancellation.loopWindowMs = 300
  cancellation.elapsedMs = 300
  cancellation.cancellation.observedMs = 251
  const result = evaluateConversationBenchmark(value)
  expect(result.status).toBe('failed')
  expect(result.failures.join(' ')).toContain('cancellation deadline exceeded')
  expect(result.incomplete.join(' ')).toContain('insufficient in-operation histogram')
})

it.each([0, 49.9, 50])(
  'proves short responsiveness by the whole-operation upper bound (%s ms)',
  (duration) => {
    const value = report()
    Object.assign(value.lanes[0].samples[0], {
      elapsedMs: duration,
      loopWindowMs: duration,
      loopSamples: 0,
      loopP95Ms: null,
      loopP99Ms: null,
      histogramMaxMs: null,
      loopMaxMs: duration,
      heartbeatMaxMs: duration,
      heartbeatFirstMs: duration,
      heartbeatTerminalMs: duration,
      heartbeatSamples: 1
    })
    const result = evaluateConversationBenchmark(value)
    expect(result.status).toBe('passed')
    expect(result.summaries[0]).toMatchObject({
      histogramSufficientSamples: 9,
      shortOperationBoundSamples: 1,
      insufficientHistogramSamples: 1,
      insufficientResponsivenessSamples: 0
    })
    expect(value.lanes[0].samples[0].loopP99Ms).toBeNull()
  }
)

it('does not relax the 50 ms upper bound or accept a window that excludes measured work', () => {
  const long = report()
  Object.assign(long.lanes[0].samples[0], {
    elapsedMs: 50.01,
    loopWindowMs: 50.01,
    loopSamples: 99
  })
  expect(evaluateConversationBenchmark(long).status).toBe('incomplete')
  const outsideWindow = report()
  Object.assign(outsideWindow.lanes[0].samples[0], {
    elapsedMs: 50.01,
    loopWindowMs: 50,
    loopSamples: 99
  })
  expect(evaluateConversationBenchmark(outsideWindow).failures.join(' ')).toContain(
    'invalid event-loop measurements'
  )
})

it('keeps sparse synchronous baseline histograms diagnostic without blocking candidate proof', () => {
  const value = report()
  const baseline = lane('baseline-journal-10000')
  for (const observation of [...baseline.warmups, ...baseline.samples]) {
    Object.assign(observation, {
      elapsedMs: 1100,
      loopWindowMs: 1100,
      loopSamples: 0,
      loopP95Ms: null,
      loopP99Ms: null,
      histogramMaxMs: null,
      loopMaxMs: 1100,
      heartbeatMaxMs: 1100,
      heartbeatFirstMs: 1100,
      heartbeatTerminalMs: 1100,
      heartbeatSamples: 1
    })
  }
  value.lanes.push(baseline)
  const result = evaluateConversationBenchmark(value)
  expect(result.status).toBe('passed')
  expect(result.summaries.at(-1)).toMatchObject({
    eventLoopAcceptance: 'diagnostic-only',
    histogramSufficientSamples: 0,
    insufficientHistogramSamples: 10,
    shortOperationBoundSamples: 0,
    insufficientResponsivenessSamples: null,
    worstLoopP99Ms: null,
    worstHeartbeatMaxMs: 1100
  })
})

it('selects canonical and cancellation lanes explicitly without weakening sampling', () => {
  expect(
    parseConversationBenchmarkArgs(['--canonical', '--cancellation', '--tiers', '0'])
  ).toMatchObject({ canonical: true, cancellation: true, runs: 10, warmups: 3, tiers: [0] })
})
