import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCanonicalBenchmark } from './conversation-context-benchmark-canonical'

it.each(['export', 'projection'] as const)(
  'audits current %s with Unicode tool bytes and exact mandatory user constraints',
  async (lane) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-canonical-benchmark-'))
    const fixture = await createCanonicalBenchmark(directory, 512 * 1024)
    try {
      expect(await fixture.run(lane, new AbortController().signal)).toMatchObject({
        status: 'completed',
        integrity: true,
        toolByteLength: 512 * 1024,
        mandatoryConstraintsPreserved: true,
        nativeAcceptance: 'not-run'
      })
      expect(fixture.transientPins()).toBe(0)
    } finally {
      fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.each(['export', 'projection'] as const)(
  'unwinds actual started %s without new dispatch or transient read pins',
  async (lane) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-canonical-cancel-'))
    const fixture = await createCanonicalBenchmark(directory, 512 * 1024)
    const controller = new AbortController()
    try {
      const dispatches = fixture.dispatchCount()
      const pending = fixture.run(lane, controller.signal)
      const claims = fixture.claimCount()
      controller.abort(new DOMException('Explicit test cancellation', 'AbortError'))
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(fixture.transientPins()).toBe(0)
      expect(fixture.dispatchCount()).toBe(dispatches)
      expect(fixture.claimCount()).toBe(claims)
    } finally {
      fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
