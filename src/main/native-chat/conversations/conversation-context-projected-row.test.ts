import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { projectConversationDisclosedRow } from './conversation-context-projected-row'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

function source(body: unknown) {
  const text = JSON.stringify({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: 9,
    ts: 1,
    fence: 1,
    kind: 'item',
    itemId: 'item',
    revision: 2,
    body
  })
  const bytes = Buffer.from(text)
  return {
    text,
    version: {
      source: { sessionId: 'session', epoch: 'epoch', sequence: 9 },
      sha256: createHash('sha256').update(bytes).digest('hex')
    },
    byteLength: bytes.length,
    artifactId: 'host-verified-artifact',
    chunks: (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 1009) {
        yield bytes.subarray(offset, offset + 1009)
      }
    })()
  }
}

it('projects a large tool result without requiring a sequence-one prefix or losing result status', async () => {
  const input = source({
    kind: 'tool-call',
    name: 'read',
    input: { path: 'test.ts' },
    state: 'completed',
    output: {
      head: '甲🙂'.repeat(40000),
      byteLength: 280000,
      digest: 'a'.repeat(64),
      truncated: false
    }
  })
  const result = await projectConversationDisclosedRow(input, new AbortController().signal)
  expect(result.original.text).toBeUndefined()
  expect(result.projection).toMatchObject({
    representation: 'summarized',
    artifactId: input.artifactId,
    spans: [{ version: input.version, startByte: 0, endByte: input.byteLength }]
  })
  expect(result.row).toMatchObject({
    seq: 9,
    revision: 2,
    body: { name: 'read', input: { path: 'test.ts' }, state: 'completed' }
  })
  expect(result.projection.text).toContain('Retrieve the original')
})

it('keeps the complete Unicode user constraint exact and rejects altered source bytes', async () => {
  const input = source({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Keep 日本語🙂. Never delete the final file.' }]
  })
  const result = await projectConversationDisclosedRow(input, new AbortController().signal)
  expect(result.projection).toMatchObject({ representation: 'exact', text: input.text })
  const corrupt = source({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'changed' }]
  })
  await expect(
    projectConversationDisclosedRow(
      { ...corrupt, version: input.version },
      new AbortController().signal
    )
  ).rejects.toThrow('invalid-provenance')
})

it('rejects invalid UTF-8 even when its byte digest matches', async () => {
  const input = source({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'content' }]
  })
  const bytes = Buffer.from(input.text)
  bytes[bytes.indexOf('content')] = 255
  await expect(
    projectConversationDisclosedRow(
      {
        ...input,
        version: { ...input.version, sha256: createHash('sha256').update(bytes).digest('hex') },
        chunks: (async function* () {
          yield bytes
        })()
      },
      new AbortController().signal
    )
  ).rejects.toThrow('invalid-provenance')
})
