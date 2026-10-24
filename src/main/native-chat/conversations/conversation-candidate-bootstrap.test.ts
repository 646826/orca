import { expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionReserveRequest } from '../../runtime/agent-session-reservation-admission'
import { readConversationSourceSegmentId } from './conversation-source-attribution'

it.each(['nonempty', 'other-epoch', 'native-handle', 'pre-existing'] as const)(
  'does not infer bootstrap provenance from %s history or commit a rejected founding',
  async (mode) => {
    const f = await createConversationSwitchFixture()
    try {
      const prior = f.records.conversations.intent(f.operationKey)!
      const initial = f.records.conversations.read(prior.conversationId)!
      await f.records.conversations.cancel({
        operationKey: prior.operationKey,
        expectedVersion: prior.version,
        expectedRevision: initial.revision,
        expectedContextGeneration: initial.contextGeneration,
        expectedActivationFence: initial.activationFence
      })
      const conversation = f.records.conversations.read(prior.conversationId)!
      const source = f.records.getRecord('session-a')!
      const now = 1800000000010
      const operation = {
        callerKey: 'caller',
        operationId: `${now}-${'2'.repeat(32)}`,
        fingerprint: mode,
        now
      }
      const candidate: AgentSessionReserveRequest = {
        sessionId: mode === 'pre-existing' ? 'session-b' : 'new-candidate',
        provider: 'codex',
        location: source.location,
        accountHome: source.accountHome,
        expectedFence: null,
        spawnToken: 'not-spawned',
        claimKeyId: 'candidate-key',
        handoffOperationId: null,
        probe: { outcome: 'pid-absent' },
        operation,
        now
      }
      const epoch = `epoch-${candidate.sessionId}`
      if (mode !== 'pre-existing') {
        insertJournalRow(f.host.db, candidate.sessionId, {
          v: 1,
          kind: 'epoch',
          seq: 1,
          epoch,
          fence: 0,
          ts: 1,
          reason: 'session_created',
          providerHandle:
            mode === 'native-handle'
              ? { kind: 'codex', threadId: 'foreign' }
              : agentSessionJournalProviderHandle({ agent: 'codex', providerHandle: null })
        })
        if (mode === 'nonempty') {
          insertJournalRow(f.host.db, candidate.sessionId, {
            v: 1,
            kind: 'item',
            seq: 2,
            epoch,
            fence: 0,
            ts: 2,
            itemId: 'existing-user',
            revision: 1,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Never guess my origin.' }]
            }
          })
        }
        if (mode === 'other-epoch') {
          insertJournalRow(f.host.db, candidate.sessionId, {
            v: 1,
            kind: 'epoch',
            seq: 1,
            epoch: 'other',
            fence: 0,
            ts: 1,
            reason: 'session_created',
            providerHandle: agentSessionJournalProviderHandle({
              agent: 'codex',
              providerHandle: null
            })
          })
        }
        publishJournalSessionEpoch(
          f.host.db,
          { sessionId: candidate.sessionId, workspaceId: source.location.workspaceId },
          epoch
        )
      }
      const request = {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        expectedNativeBindingGeneration: 1,
        target: candidate
      }
      if (mode === 'pre-existing') {
        const begun = await f.records.conversations.beginSwitch(request, operation)
        expect(begun.intent).not.toBeNull()
      } else {
        await expect(
          f.records.conversations.beginSwitch(request, operation, candidate)
        ).rejects.toThrow('unverified-delivery')
        expect(f.records.getRecord(candidate.sessionId)).toBeNull()
        expect(f.records.getOperationRow(operation.callerKey, operation.operationId)).toBeNull()
        expect(
          f.records.conversations.read(conversation.conversationId)?.pendingOperationKey
        ).toBeNull()
        expect(
          f.host.db
            .prepare('SELECT 1 FROM conversation_participants WHERE session_id=?')
            .get(candidate.sessionId)
        ).toBeUndefined()
      }
      expect(
        readConversationSourceSegmentId(f.host.db, {
          sessionId: candidate.sessionId,
          epoch,
          sequence: 1
        })
      ).toBeNull()
    } finally {
      f.close()
    }
  }
)
