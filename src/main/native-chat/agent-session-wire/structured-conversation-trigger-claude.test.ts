import { readConversationNativeIdentity } from '../conversations/conversation-origin-native-identity'
import { expect, it, vi } from 'vitest'
import {
  adapterAtPublishFor,
  fakeClaude,
  claudeFrame,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { nativeTriggerFixture } from './structured-conversation-native-trigger.fixture'

it.each(['exact', 'wrong-uuid', 'lost'] as const)(
  'Claude host first-turn acceptance: %s',
  async (mode) => {
    const f = await nativeTriggerFixture({
      handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
      params: {
        agent: 'claude',
        provider: 'claude',
        providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' }
      }
    })
    const claude = fakeClaude({ initProof: 'none', replayUuid: null })
    const adapter = adapterAtPublishFor(
      claude,
      {},
      [],
      [],
      undefined,
      undefined,
      undefined,
      f.settle
    )
    try {
      const acquired = await adapter.acquire({ ...f.acquisition, onSpawned: undefined })
      await adapter.open({
        sessionId: f.targetId,
        fence: f.acquisition.fence,
        acquisitionGeneration: acquired.acquisitionGeneration!,
        signal: new AbortController().signal
      })
      expect(claude.connections[0]!.sent).toHaveLength(0)
      f.dispatch.mockImplementation((input) => adapter.dispatch(input))
      await f.append()
      await vi.waitFor(() =>
        expect(
          claude.connections[0]!.sent,
          JSON.stringify({
            submission: f.journal.submission(f.request.targetSubmissionId),
            calls: f.dispatch.mock.calls.length
          })
        ).toHaveLength(1)
      )
      const sent = claude.connections[0]!.sent[0]!
      if (mode === 'lost') {
        await adapter.closeAll()
      } else {
        claudeFrame(claude.connections[0]!, {
          ...sent,
          uuid: mode === 'exact' ? sent.uuid : 'unrelated-uuid'
        })
      }
      await f.flush()
      if (mode === 'exact') {
        await vi.waitFor(async () => {
          await f.flush()
          expect(
            await f.receipt(),
            JSON.stringify({
              submission: f.journal.submission(f.request.targetSubmissionId),
              receipt: f.journal.receiptFor(f.request.targetSubmissionId),
              unresolved: f.db
                .prepare(
                  'SELECT * FROM conversation_origin_rows WHERE session_id=? AND origin_json IS NULL'
                )
                .all(f.targetId)
            })
          ).not.toBeNull()
        })
        await f.activate()
        expect(f.store.conversations.route(f.targetId).role).toBe('active')
      } else {
        expect(await f.receipt()).toBeNull()
        expect(f.store.conversations.route(f.targetId).role).not.toBe('active')
      }
      await f.flush()
      expect(
        claude.connections[0]!.sent,
        JSON.stringify({
          submission: f.journal.submission(f.request.targetSubmissionId),
          calls: f.dispatch.mock.calls.length
        })
      ).toHaveLength(1)
    } finally {
      await adapter.closeAll()
    }
  }
)

it('does not bind foreign native lifecycle namespaces or stale acquisition evidence', async () => {
  const f = await nativeTriggerFixture({
    handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
    params: {
      agent: 'claude',
      provider: 'claude',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' }
    }
  })
  f.settle({
    state: 'origin-correlated',
    sessionId: f.targetId,
    clientMessageId: f.request.targetSubmissionId,
    fence: f.acquisition.fence,
    turnIdentity: {
      provider: 'legacy',
      agent: 'claude',
      sessionId: 'foreign-native-session',
      recordId: 'turn-lifecycle:foreign'
    }
  })
  await f.flush()
  // A callback from the old acquisition cannot use the new account/native identity as proof.
  f.db
    .prepare(
      "UPDATE conversation_origin_acquisitions SET native_identity='old-native-identity' WHERE session_id=? AND fence=?"
    )
    .run(f.targetId, f.acquisition.fence)
  f.settle({
    state: 'origin-correlated',
    sessionId: f.targetId,
    clientMessageId: f.request.targetSubmissionId,
    fence: f.acquisition.fence,
    turnIdentity: {
      provider: 'legacy',
      agent: 'claude',
      sessionId: PROVIDER_SESSION_ID,
      recordId: 'turn-lifecycle:stale'
    }
  })
  await f.flush()
  expect(
    f.db
      .prepare('SELECT resolved FROM conversation_origin_correlations WHERE session_id=?')
      .all(f.targetId)
  ).toEqual([{ resolved: 0 }, { resolved: 0 }])
  expect(await f.receipt()).toBeNull()
})

it('keeps native identity stable across Claude resume cursor advancement, but not native replacement', async () => {
  const f = await nativeTriggerFixture({
    handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
    params: {
      agent: 'claude',
      provider: 'claude',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' }
    }
  })
  const before = readConversationNativeIdentity(f.db, f.targetId)
  expect(before).not.toBeNull()
  f.db
    .prepare(
      "UPDATE agent_session_records SET record_json=json_set(record_json,'$.providerHandleChain[#-1].handle.leafUuid','advanced-uuid') WHERE session_id=?"
    )
    .run(f.targetId)
  expect(readConversationNativeIdentity(f.db, f.targetId)).toBe(before)
  f.db
    .prepare(
      "UPDATE agent_session_records SET record_json=json_set(record_json,'$.providerHandleChain[#-1].handle.sessionId','foreign-native-session') WHERE session_id=?"
    )
    .run(f.targetId)
  expect(readConversationNativeIdentity(f.db, f.targetId)).not.toBe(before)
})
