import { prepareConversationExactRows } from './conversation-preparation-rows'
import { freezeConversationPreparationSources } from './conversation-preparation-sources'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { readConversationTransportSubmission } from './conversation-transport-submission'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { projectConversationTransportRow } from './conversation-transport-projection'

it('preserves ordinary user text that is byte-identical to a transport envelope without transfer provenance', async () => {
  const text = '{"historicalEvidence":[],"activeConstraints":[]}'
  const f = await createConversationSwitchFixture(text)
  try {
    const source = { sessionId: 'session-a', epoch: 'epoch-session-a', sequence: 2 }
    const raw = f.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(source.sessionId, source.epoch, source.sequence)?.row_json
    if (typeof raw !== 'string') {
      throw new Error('missing ordinary user row')
    }
    const intent = f.records.conversations.intent(f.operationKey)!
    expect(
      projectConversationTransportRow(
        f.host.db,
        intent,
        {
          source,
          sha256: createHash('sha256').update(raw).digest('hex')
        },
        raw
      )
    ).toBeNull()
    expect(JSON.parse(raw).body.blocks).toEqual([{ type: 'text', text }])
  } finally {
    f.close()
  }
})

it('reports the existing serialized-row bound instead of silently accepting escaped over-limit history', async () => {
  const limit = 1024 * 1024
  const text = '"'.repeat(600_000)
  expect(Buffer.byteLength(text)).toBeLessThan(limit)
  const f = await createConversationSwitchFixture(text)
  try {
    const intent = f.records.conversations.intent(f.operationKey)!
    const signal = new AbortController().signal
    const snapshot = await freezeConversationPreparationSources(f.host.db, intent, signal)
    const raw = f.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND seq=2')
      .get('session-a')?.row_json
    if (typeof raw !== 'string') {
      throw new Error('source missing')
    }
    expect(Buffer.byteLength(raw)).toBeGreaterThan(limit)
    const prepare = vi.spyOn(f.host.db, 'prepare')
    try {
      expect(
        readConversationTransportSubmission(f.host.db, intent, {
          sessionId: 'session-a',
          epoch: 'epoch-session-a',
          sequence: 2
        })
      ).toBeNull()
      expect(
        prepare.mock.calls.some(([sql]) => sql.includes('CASE WHEN octet_length(row_json)'))
      ).toBe(false)
    } finally {
      prepare.mockRestore()
    }
    const read = async () => {
      for await (const _row of prepareConversationExactRows({
        db: f.host.db,
        stateDirectory: f.host.stateDirectory,
        store: new AgentSessionAttachmentStore(
          agentSessionAttachmentStoreRoot(f.host.stateDirectory),
          { hasSession: (id) => f.records.getRecord(id) !== null }
        ),
        conversationId: intent.conversationId,
        snapshot,
        targetBindingDigest: 'a'.repeat(64),
        maxBytes: limit,
        signal
      })) {
        // Exhaust the real producer; the oversized row must refuse rather than disappear.
      }
    }
    await expect(read()).rejects.toThrow('resource-limit')
    expect(
      f.host.db
        .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND seq=2')
        .get('session-a')?.row_json
    ).toBe(raw)
  } finally {
    f.close()
  }
})
