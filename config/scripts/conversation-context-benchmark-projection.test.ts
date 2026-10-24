import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPreparationBenchmarkFixture } from './conversation-context-benchmark-preparation-fixture'
import {
  auditPreparationBenchmarkPart,
  auditPreparationBenchmarkSources
} from './conversation-context-benchmark-preparation-audit'
import { readConversationManifest } from '../../src/main/native-chat/conversations/conversation-context-coverage'
import { readConversationManifestParts } from '../../src/main/native-chat/conversations/conversation-context-parts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('compiles real tools projection, approves its exact manifest and audits original exports', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-projection-benchmark-'))
  roots.push(stateDirectory)
  const fixture = await createPreparationBenchmarkFixture({
    stateDirectory,
    eventCount: 10,
    policy: 'budgeted',
    projection: 'tools',
    requiredTextBytes: 32,
    toolRowBytes: 512 * 1024
  })
  try {
    const result = await fixture.run(new AbortController().signal)
    expect(result).toMatchObject({
      status: 'completed',
      integrity: true,
      sourceCount: 13,
      projection: 'tools',
      summarizedSourceCount: 1,
      exportedSourceCount: 13,
      consent: 'approved-exact-manifest',
      nativeAcceptance: 'not-run'
    })
    if (result.status !== 'completed' || typeof result.manifestId !== 'string') {
      throw new Error('No manifest')
    }
    const manifest = readConversationManifest(fixture.host.db, result.manifestId)
    if (!manifest?.evidenceIndex) {
      throw new Error('No real compiler index')
    }
    const parts = readConversationManifestParts(
      fixture.host.db,
      manifest.evidenceIndex.indexId,
      0,
      128
    )
    const tool = parts.find(({ part }) => part.representation === 'summarized')?.part
    if (!tool) {
      throw new Error('No real tool projection')
    }
    const raw = fixture.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(
        tool.version.source.sessionId,
        tool.version.source.epoch,
        tool.version.source.sequence
      )?.row_json
    if (typeof raw !== 'string') {
      throw new Error('No canonical source')
    }
    expect(() => auditPreparationBenchmarkPart(raw, tool, 'tools')).not.toThrow()
    expect(() => auditPreparationBenchmarkPart(raw, tool, 'exact')).toThrow()
    for (const corrupt of [
      { ...tool, text: tool.text?.replace('Read', 'Write') },
      { ...tool, version: { ...tool.version, sha256: '0'.repeat(64) } },
      { ...tool, spans: tool.spans.map((span) => ({ ...span, endByte: span.endByte - 1 })) }
    ]) {
      expect(() => auditPreparationBenchmarkPart(raw, corrupt, 'tools')).toThrow()
    }
    const mandatory = parts.find(({ part }) =>
      part.text?.includes('Never delete the final constraint.')
    )?.part
    if (!mandatory) {
      throw new Error('Missing mandatory constraint')
    }
    expect(mandatory.representation).toBe('exact')
    const all = parts.map(({ part }) => part)
    for (const projection of [all.slice(1), [...all, tool], all.toReversed()]) {
      await expect(
        auditPreparationBenchmarkSources(
          fixture.host.db,
          { ...manifest, evidenceIndex: undefined, projection },
          fixture.sourceCount,
          fixture.expectedRoot,
          fixture.expectedRoot,
          new AbortController().signal,
          { projection: 'tools' }
        )
      ).rejects.toThrow('Incomplete source enumeration')
    }
  } finally {
    fixture.close()
  }
})

it('does not turn a tools-path mandatory inline refusal into successful scale coverage', async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-projection-refusal-'))
  roots.push(stateDirectory)
  const fixture = await createPreparationBenchmarkFixture({
    stateDirectory,
    eventCount: 10,
    policy: 'budgeted',
    projection: 'tools',
    requiredTextBytes: 1024 * 1024 + 1
  })
  try {
    expect(await fixture.run(new AbortController().signal)).toMatchObject({
      status: 'capacity-refused',
      integrity: false,
      nativeAcceptance: 'not-run'
    })
  } finally {
    fixture.close()
  }
})
