import { expect, it, vi } from 'vitest'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  attach,
  hostTestState,
  replaceHostTestState,
  CALLER
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readConversationFreshNativeProof } from '../conversations/conversation-pending-native-identity'
it.each([
  { acquiredLink: false, early: false },
  { acquiredLink: true, early: false },
  { acquiredLink: false, early: true }
])('gates empty-chain candidate before model dispatch: %j', async ({ acquiredLink, early }) => {
  await attach()
  const state = hostTestState()
  const source = state.store.getRecord(HOST_TEST_SESSION)!
  const targetId = 'fresh-candidate'
  await state.store.founding.commit({
    sessionId: targetId,
    provider: 'codex',
    location: source.location,
    accountHome: source.accountHome,
    expectedFence: null,
    spawnToken: 'found-only',
    claimKeyId: 'key',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'found-fresh'
    },
    now: HOST_TEST_NOW
  })
  const db = openTestJournalHostDatabase(state.root)
  await openAgentSessionJournal({
    database: db,
    identity: {
      sessionId: targetId,
      workspaceId: source.location.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    }
  })
  const conversation = await state.store.conversations.ensureSingleton(HOST_TEST_SESSION)
  const begun = await state.store.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: conversation.activationFence,
      target: state.store.getRecord(targetId)!,
      expectedNativeBindingGeneration: 1
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'fresh-switch',
      now: HOST_TEST_NOW
    }
  )
  const intent = begun.intent!
  const link = (fence: number) => ({
    linkId: 'native-first',
    handle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f61'),
    origin: 'created' as const,
    mintedAtFence: fence,
    observedAt: HOST_TEST_NOW
  })
  state.acquire.mockImplementation(async (input) => ({
    acquisitionGeneration: 'fresh-child',
    process: {
      hostId: 'local',
      pid: 1234,
      processStartTimeMs: HOST_TEST_NOW,
      spawnToken: state.store.getRecord(targetId)!.lease.reservedSpawnToken!
    },
    ...(acquiredLink ? { link: link(input.fence) } : {})
  }))
  state.host.deps.adapter.open = async (input) => {
    expect(state.dispatch).not.toHaveBeenCalled()
    expect(
      readConversationFreshNativeProof(db.db, {
        sessionId: targetId,
        operationKey: intent.operationKey
      }) !== null
    ).toBe(acquiredLink)
    if (early) {
      state.acquire.mock.calls.at(-1)![0].events!.appendItem(
        {
          provider: 'codex',
          threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f61',
          turnId: 'unrequested-turn',
          ordinal: 0
        },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Unrequested model output before identity publication' }]
        },
        { turnScope: { kind: 'thread' } }
      )
    }
    return { reportedOptions: {}, ...(acquiredLink ? {} : { link: link(input.fence) }) }
  }
  const prepare = vi.fn(async () => {
    if (early) {
      expect(
        readConversationFreshNativeProof(db.db, {
          sessionId: targetId,
          operationKey: intent.operationKey
        })
      ).toBeNull()
      expect(state.store.getRecord(targetId)!.providerHandleChain).toHaveLength(0)
      return { kind: 'blocked' as const, reasons: ['native-identity-unverified'] }
    }
    expect(
      readConversationFreshNativeProof(db.db, {
        sessionId: targetId,
        operationKey: intent.operationKey
      })
    ).not.toBeNull()
    expect(state.dispatch).not.toHaveBeenCalled()
    return { kind: 'blocked' as const, reasons: ['capability-unverified'] }
  })
  const host = new StructuredAgentSessionHost({
    ...state.host.deps,
    conversationPreparationFactory: () => ({
      preparation: {
        prepare,
        readPlan: () => null,
        verifyTrigger: () => {
          throw new Error('unverified')
        }
      },
      readPreparationEvidence: () => null,
      canRetrieve: () => false
    })
  })
  replaceHostTestState({ host, store: state.store })
  if (early) {
    expect(
      await host.deps.conversationSwitchRuntime!.prepare(intent, null, new AbortController().signal)
    ).toEqual({ kind: 'blocked', reasons: ['native-identity-unverified'] })
    expect(prepare).toHaveBeenCalledOnce()
    expect(
      readConversationFreshNativeProof(db.db, {
        sessionId: targetId,
        operationKey: intent.operationKey
      })
    ).toBeNull()
  } else {
    expect(
      await host.deps.conversationSwitchRuntime!.prepare(intent, null, new AbortController().signal)
    ).toEqual({ kind: 'blocked', reasons: ['capability-unverified'] })
    expect(prepare).toHaveBeenCalledOnce()
  }
  expect(state.dispatch).not.toHaveBeenCalled()
})
