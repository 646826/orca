import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import {
  benchmarkChildReceipt,
  benchmarkChildSample,
  benchmarkChildTimeoutMs,
  benchmarkPhase
} from './conversation-context-benchmark-process.mjs'

const result = (overrides = {}) => ({
  code: 0,
  signal: null,
  timedOut: false,
  outputTruncated: false,
  stdout: JSON.stringify({ status: 'completed', integrity: true, elapsedMs: 123 }),
  stderr: '',
  ...overrides
})
const phase = (name) =>
  `ORCA_BENCHMARK_PHASE ${JSON.stringify({ phase: name, at: '2026-10-23T00:00:00.000Z' })}\n`

it('preserves the actual successful sample and phase receipt separately', () => {
  const child = result({
    stderr: `Runtime warning\n${phase('setup-start')}${phase('setup-end')}${phase('operation-end')}${phase('cleanup-end')}`
  })
  const receipt = benchmarkChildReceipt(child, 120000)
  expect(benchmarkChildSample(child, receipt)).toMatchObject({
    status: 'completed',
    integrity: true,
    elapsedMs: 123,
    process: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      timeoutMs: 120000,
      phases: [
        { phase: 'setup-start' },
        { phase: 'setup-end' },
        { phase: 'operation-end' },
        { phase: 'cleanup-end' }
      ],
      phaseErrors: []
    }
  })
})

it.each([{ code: 7 }, { code: null, signal: 'SIGTERM' }, { outputTruncated: true }])(
  'never counts terminated or truncated output as successful (%j)',
  (overrides) => {
    const child = result(overrides)
    const receipt = benchmarkChildReceipt(child, 120000)
    expect(benchmarkChildSample(child, receipt)).toMatchObject({
      status: 'failed',
      childResult: { status: 'completed', integrity: true, elapsedMs: 123 },
      process: { exitCode: child.code, signal: child.signal, timedOut: false }
    })
  }
)

it.each(['', 'not JSON', 'null', '[]', '42', '{}'])(
  'rejects missing or non-sample structured output (%s)',
  (stdout) => {
    const child = result({ stdout })
    expect(benchmarkChildSample(child, benchmarkChildReceipt(child, 120000))).toMatchObject({
      status: 'failed',
      reason: 'Missing structured child result'
    })
  }
)

it('retains a parsed measurement when cleanup hits the infrastructure watchdog', () => {
  const child = result({
    code: null,
    signal: 'SIGTERM',
    timedOut: true,
    stderr: `${phase('setup-start')}${phase('setup-end')}${phase('operation-end')}`
  })
  expect(benchmarkChildSample(child, benchmarkChildReceipt(child, 600000))).toMatchObject({
    status: 'infrastructure-timeout',
    lastPhase: 'operation-end',
    childResult: { status: 'completed', integrity: true, elapsedMs: 123 },
    process: { timedOut: true, signal: 'SIGTERM', timeoutMs: 600000 }
  })
})

it('never treats a kill request or an unverified timeout as proof of child termination', () => {
  const child = result({ code: null, signal: null, timedOut: true })
  const unknown = benchmarkChildReceipt(child, 600000, false)
  expect(unknown.terminationVerified).toBe(false)
  expect(benchmarkChildSample(child, unknown)).toMatchObject({
    status: 'infrastructure-timeout',
    process: { terminationVerified: false }
  })
  expect(benchmarkChildReceipt(child, 600000, true).terminationVerified).toBe(true)
  const unverified = result({ code: null, signal: null })
  expect(
    benchmarkChildSample(unverified, benchmarkChildReceipt(unverified, 600000, false))
  ).toMatchObject({ status: 'infrastructure-termination-unknown' })
})

it.each([
  'ORCA_BENCHMARK_PHASE broken\n',
  phase('unknown'),
  'ORCA_BENCHMARK_PHASE {"phase":"setup-start","at":"not-a-date"}\n',
  phase('setup-start') + phase('setup-start'),
  phase('setup-end') + phase('setup-start')
])('does not accept malformed or out-of-order phase evidence', (stderr) => {
  const child = result({ stderr })
  const receipt = benchmarkChildReceipt(child, 120000)
  expect(receipt.phaseErrors.length).toBeGreaterThan(0)
  expect(benchmarkChildSample(child, receipt)).toMatchObject({
    status: 'failed',
    reason: 'Invalid child phase evidence'
  })
})

it('rejects an unknown phase before emitting it', () => {
  expect(() => benchmarkPhase('unknown')).toThrow('Invalid benchmark phase')
})

it('predeclares a larger infrastructure watchdog only for the 100k scale arms', () => {
  for (const arm of [
    'journal',
    'baseline-journal',
    'preparation-full',
    'preparation-budgeted',
    'projection-scale'
  ]) {
    expect(benchmarkChildTimeoutMs(arm, 100000)).toBe(600000)
    expect(benchmarkChildTimeoutMs(arm, 10000)).toBe(120000)
    expect(benchmarkChildTimeoutMs(arm, 1000)).toBe(120000)
  }
  expect(benchmarkChildTimeoutMs('artifact', 100000)).toBe(120000)
  expect(benchmarkChildTimeoutMs('projection', 64)).toBe(120000)
})

it('classifies a real child killed during setup as infrastructure timeout, not product failure', async () => {
  const moduleUrl = new URL('./conversation-context-benchmark-process.mjs', import.meta.url).href
  const child = await runProcess({
    program: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `import { benchmarkPhase } from ${JSON.stringify(moduleUrl)};
       benchmarkPhase('setup-start');
       setTimeout(() => {}, 30000);`
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 2000,
    maxOutputBytes: 4096
  })
  const receipt = benchmarkChildReceipt(child, 2000)
  expect(child.timedOut).toBe(true)
  expect(benchmarkChildSample(child, receipt)).toMatchObject({
    status: 'infrastructure-timeout',
    lastPhase: 'setup-start',
    process: { timedOut: true, timeoutMs: 2000, phases: [{ phase: 'setup-start' }] }
  })
})
