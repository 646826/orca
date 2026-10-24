import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createPreparationBenchmarkFixture } from './conversation-context-benchmark-preparation-fixture'

it.each(['full', 'budgeted'] as const)(
  'audits every canonical source through real %s preparation and consent',
  async (policy) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-benchmark-'))
    const fixture = await createPreparationBenchmarkFixture({
      stateDirectory: directory,
      eventCount: 10,
      policy
    })
    try {
      const result = await fixture.run(new AbortController().signal)
      expect(result).toMatchObject({
        status: 'completed',
        integrity: true,
        sourceCount: 11,
        consent: policy === 'budgeted' ? 'approved-exact-manifest' : 'not-required'
      })
      expect(result.nativeAcceptance).toBe('not-run')
    } finally {
      fixture.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('classifies mandatory inline overflow as a capacity refusal, never successful performance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-preparation-overflow-'))
  const fixture = await createPreparationBenchmarkFixture({
    stateDirectory: directory,
    eventCount: 10,
    policy: 'budgeted',
    requiredTextBytes: 1024 * 1024 + 1
  })
  try {
    expect(await fixture.run(new AbortController().signal)).toMatchObject({
      status: 'capacity-refused',
      integrity: false,
      reasons: ['resource-limit']
    })
  } finally {
    fixture.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
