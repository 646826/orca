import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { runConversationBenchmark } from './conversation-context-benchmark.mjs'

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    runProcess: vi.fn(async (spec) => {
      if (spec.args?.[0]?.endsWith('measurement.cjs')) {
        return {
          code: null,
          signal: null,
          timedOut: true,
          stdout: '{"status":"completed","integrity":true}',
          stderr: 'ORCA_BENCHMARK_PHASE {"phase":"setup-start","at":"2026-10-23T00:00:00.000Z"}\n'
        }
      }
      return actual.runProcess(spec)
    })
  }
})

it('retains an uncertain child receipt and stops the real runner before scheduling another child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-benchmark-unknown-exit-'))
  const output = join(root, 'result')
  try {
    await expect(
      runConversationBenchmark(['--output', output, '--tiers', '0', '--events', '1000', '--check'])
    ).rejects.toThrow('Child termination not verified')
    const children = vi
      .mocked(runProcess)
      .mock.calls.filter(([spec]) => spec.args?.[0]?.endsWith('measurement.cjs'))
    expect(children).toHaveLength(1)
    expect(children[0][0]).toMatchObject({
      terminationBarrier: true,
      onChildTerminated: expect.any(Function)
    })
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    expect(report.evaluation.status).toBe('incomplete')
    expect(report.stoppedReason).toContain('no further measurements')
    expect(report.lanes[0].warmups[0]).toMatchObject({
      status: 'infrastructure-timeout',
      childResult: { status: 'completed', integrity: true },
      process: { terminationVerified: false, exitCode: null, signal: null, timedOut: true }
    })
    expect(report.sourceAfter).toBe(report.sourceBefore)
    expect(await readFile(join(output, 'artifact-0-warmups-0.stdout.log'), 'utf8')).toBe(
      '{"status":"completed","integrity":true}'
    )
    expect(
      JSON.parse(await readFile(join(output, 'artifact-0-warmups-0.process.json'), 'utf8'))
    ).toMatchObject({
      terminationVerified: false,
      timedOut: true,
      phases: [{ phase: 'setup-start' }]
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
