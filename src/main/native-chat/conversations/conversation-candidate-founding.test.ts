import { expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { publishJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import type { AgentSessionReserveRequest } from '../../runtime/agent-session-reservation-admission'

it('founds a parked candidate and intent in one ledger commit, with replay and conflict protection', async () => {
  const f = await createConversationSwitchFixture()
  try {
    const prior = f.records.conversations.intent(f.operationKey)!
    const original = f.records.conversations.read(prior.conversationId)!
    await f.records.conversations.cancel({
      operationKey: prior.operationKey,
      expectedVersion: prior.version,
      expectedRevision: original.revision,
      expectedContextGeneration: original.contextGeneration,
      expectedActivationFence: original.activationFence
    })
    const conversation = f.records.conversations.read(prior.conversationId)!
    const now = 1_800_000_000_010
    const operation = {
      callerKey: 'caller',
      operationId: `${now}-${'2'.repeat(32)}`,
      fingerprint: 'candidate',
      now
    }
    const source = f.records.getRecord('session-a')!
    const candidate: AgentSessionReserveRequest = {
      sessionId: 'new-candidate',
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
    f.append(candidate.sessionId, 1)
    f.host.db
      .prepare(
        "UPDATE journal_rows SET row_json=json_set(row_json,'$.providerHandle',json(?)) WHERE session_id=?"
      )
      .run(
        JSON.stringify(agentSessionJournalProviderHandle({ agent: 'codex', providerHandle: null })),
        candidate.sessionId
      )
    publishJournalSessionEpoch(
      f.host.db,
      { sessionId: candidate.sessionId, workspaceId: source.location.workspaceId },
      `epoch-${candidate.sessionId}`
    )
    const request = {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      expectedNativeBindingGeneration: 1,
      target: candidate
    }
    const wrongScope = {
      ...candidate,
      location: { ...candidate.location, wslDistro: 'other-distro' }
    }
    await expect(
      f.records.conversations.beginSwitch({ ...request, target: wrongScope }, operation, wrongScope)
    ).rejects.toThrow('scope-mismatch')
    expect(f.records.getRecord(candidate.sessionId)).toBeNull()
    expect(f.records.getOperationRow(operation.callerKey, operation.operationId)).toBeNull()
    expect(
      f.records.conversations.read(conversation.conversationId)?.pendingOperationKey
    ).toBeNull()
    const result = await f.records.conversations.beginSwitch(request, operation, candidate)
    expect(result.intent?.targetSessionId).toBe(candidate.sessionId)
    const record = f.records.getRecord(candidate.sessionId)!
    expect(record.providerHandleChain).toEqual([])
    expect(record.lease.claimStatus).toBe('released')
    expect(f.records.getSessionTabId(candidate.sessionId)).toBeNull()
    expect(f.records.conversations.route(candidate.sessionId).role).toBe('candidate')
    const replay = await f.records.conversations.beginSwitch(request, operation, candidate)
    expect(replay.intent).toEqual(result.intent)
    const conflict = await f.records.conversations.beginSwitch(
      request,
      { ...operation, fingerprint: 'changed' },
      candidate
    )
    expect(conflict.decision.decision).toBe('refused')
  } finally {
    f.close()
  }
})
