import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { projectConversationDisclosedRow } from './conversation-context-projected-row'
import { startJournalRowFold } from '../agent-session-journal/journal-open'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

const base = { epoch: 'e', ts: 1, fence: 1, v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION }
function rows() {
  return [
    JSON.stringify({
      ...base,
      kind: 'epoch',
      seq: 1,
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 't' }
    }),
    JSON.stringify({
      ...base,
      kind: 'item',
      seq: 2,
      itemId: 'codex:tool:1',
      revision: 1,
      body: {
        kind: 'tool-call',
        name: 'read',
        input: { path: 'test.txt' },
        state: 'completed',
        output: {
          head: '甲🙂'.repeat(40000),
          byteLength: 280000,
          digest: 'a'.repeat(64),
          truncated: false
        }
      }
    }),
    JSON.stringify({
      ...base,
      kind: 'item',
      seq: 3,
      itemId: 'codex:user:1',
      revision: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Do not delete "重要"\nKeep all files.' }]
      }
    })
  ]
}
async function* sourceRows(texts = rows()) {
  for (const [index, text] of texts.entries()) {
    const bytes = Buffer.from(text)
    yield {
      version: {
        source: { sessionId: 'a', epoch: 'e', sequence: index + 1 },
        sha256: createHash('sha256').update(bytes).digest('hex')
      },
      byteLength: bytes.length,
      artifactId: 'verified-archive',
      chunks: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 113) {
          yield bytes.subarray(offset, offset + 113)
        }
      })()
    }
  }
}
it('uses canonical reducer with explicit tool projection while preserving user bytes and tool lifecycle', async () => {
  const projected: Awaited<ReturnType<typeof projectConversationDisclosedRow>>[] = []
  const reduced = startJournalRowFold({ sessionId: 'a', epoch: 'e' })
  for await (const source of sourceRows()) {
    const row = await projectConversationDisclosedRow(source, new AbortController().signal)
    projected.push(row)
    expect(reduced.add({ seq: row.row.seq, rowJson: row.projection.text! })).toBe(true)
  }
  const result = {
    originals: projected.map((r) => r.original),
    projection: projected.map((r) => r.projection),
    effective: reduced.finish()
  }
  const fold = startJournalRowFold({ sessionId: 'a', epoch: 'e' })
  rows().forEach((rowJson, index) => fold.add({ seq: index + 1, rowJson }))
  const original = fold.finish()
  const before = original.state.items.get('codex:tool:1')
  const after = result.effective.state.items.get('codex:tool:1')
  if (before?.body.kind !== 'tool-call' || after?.body.kind !== 'tool-call') {
    throw new Error('expected tool')
  }
  expect({ ...after, body: { ...after.body, output: undefined } }).toEqual({
    ...before,
    body: { ...before.body, output: undefined }
  })
  expect(result.effective.state.items.get('codex:user:1')).toEqual(
    original.state.items.get('codex:user:1')
  )
  expect(result.originals[1].text).toBeUndefined()
  expect(result.projection[1]).toMatchObject({
    representation: 'summarized',
    artifactId: 'verified-archive'
  })
  expect(result.projection[1].spans[0].endByte).toBe(Buffer.byteLength(rows()[1]))
  expect(result.originals[2].text).toBe(rows()[2])
})
it('reports captured-incomplete diff patches even when no projection substitution was needed', async () => {
  const texts = rows().slice(0, 1)
  texts.push(
    JSON.stringify({
      ...base,
      kind: 'item',
      seq: 2,
      itemId: 'codex:diff:1',
      revision: 1,
      body: {
        kind: 'diff',
        path: 'a.ts',
        patch: {
          head: '@@ truncated patch',
          byteLength: 900,
          digest: 'a'.repeat(64),
          truncated: true
        }
      }
    })
  )
  for await (const source of sourceRows(texts)) {
    const result = await projectConversationDisclosedRow(source, new AbortController().signal)
    if (source.version.source.sequence === 2) {
      expect(result.original.gaps).toEqual([
        { source: source.version.source, reason: 'captured-incomplete', critical: false }
      ])
    }
  }
})
it('keeps newer canonical schema refusal distinct from corrupt evidence', async () => {
  const newer = JSON.stringify({
    ...base,
    v: 999,
    kind: 'epoch',
    seq: 1,
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 't' }
  })
  for await (const source of sourceRows([newer])) {
    await expect(
      projectConversationDisclosedRow(source, new AbortController().signal)
    ).rejects.toThrow('newer-schema')
  }
})
