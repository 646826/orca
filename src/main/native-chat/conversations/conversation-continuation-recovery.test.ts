import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import { afterEach, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { ConversationTransferRecoveryAction } from '../../../shared/conversation-transfer-recovery'
import {
  adapterAtPublishFor,
  claudeFrame,
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { CALLER } from '../agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestMessage,
  hostTestOperationId
} from '../agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionPreDispatchError } from '../agent-session-wire/structured-agent-session-operation-settlement'
import {
  conversationContinuationTransferId,
  drainConversationContinuations
} from '../agent-session-wire/structured-conversation-continuation'
import { nativeTriggerFixture } from '../agent-session-wire/structured-conversation-native-trigger.fixture'
import { readConversationTransferIntentions } from './conversation-transfer-recovery-view'
import { readConversationTransfer } from './conversation-trigger-reservation'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
})

async function fixture(preWrite = true) {
  const f = await nativeTriggerFixture({
    handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
    params: {
      agent: 'claude',
      provider: 'claude',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' }
    }
  })
  const draft = await f.source.queuedMessages.insert({
    messageId: 'continuation-original',
    body: hostTestMessage('second intention 日本語🙂'),
    options: { model: 'original-source-model' }
  })
  const claude = fakeClaude({ initProof: 'none', replayUuid: null })
  const adapter = adapterAtPublishFor(claude, {}, [], [], undefined, undefined, undefined, f.settle)
  cleanups.push(() => adapter.closeAll())
  const acquired = await adapter.acquire({ ...f.acquisition, onSpawned: undefined })
  await adapter.open({
    sessionId: f.targetId,
    fence: f.acquisition.fence,
    acquisitionGeneration: acquired.acquisitionGeneration!,
    signal: new AbortController().signal
  })
  f.dispatch.mockImplementation((input) => adapter.dispatch(input))
  await f.append()
  await vi.waitFor(() => expect(claude.connections[0]?.sent).toHaveLength(1))
  const connection = claude.connections[0]!
  claudeFrame(connection, connection.sent[0]!)
  await vi.waitFor(async () => {
    await f.flush()
    expect(await f.receipt()).not.toBeNull()
  })
  await f.activate()
  claudeFrame(connection, {
    type: 'result',
    subtype: 'success',
    uuid: 'trigger-result',
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: null,
    is_error: false,
    duration_ms: 1
  })
  await f.flush()
  const parent = f.store.conversations.intent(f.intent.operationKey)!
  const parentTransfer = readConversationTransfer(f.db, f.request.transferId)
  const parentOperation = f.store
    .listOperationRows()
    .find((row) => agentSessionOperationKey(row.callerKey, row.operationId) === parent.operationKey)
  expect(parentOperation?.outcome.status).toBe('succeeded')
  const parentReceipt = f.db
    .prepare('SELECT evidence_json FROM conversation_delivery_receipts WHERE receipt_id=?')
    .get(parent.deliveryReceiptId)?.evidence_json
  expect(typeof parentReceipt).toBe('string')
  const conversation = f.store.conversations.read(f.intent.conversationId)!
  expect(parent.phase).toBe('activated')
  expect(f.source.queuedMessages.get(draft.messageId)?.state).toBe('waiting')
  if (preWrite) {
    f.dispatch.mockImplementation((input) =>
      adapter.dispatch({
        ...input,
        beforeContextDispatch: async () => {
          throw new AgentSessionPreDispatchError('candidate-context-unverified')
        }
      })
    )
  } else {
    const send = connection.send
    connection.send = async (...args) => {
      await send(...args)
      throw new Error('transport lost after continuation user frame')
    }
  }
  const transferId = conversationContinuationTransferId(parent.operationKey, {
    sessionId: f.request.queueSessionId,
    messageId: draft.messageId
  })
  const targetSubmissionId = `${transferId}:submission`
  expect(
    await drainConversationContinuations(
      {
        db: f.db,
        stateDirectory: f.claimsHost.stateDirectory,
        deliveryHost: f.deliveryHost,
        publishSourceQueue: () => {},
        now: () => 2
      },
      parent.operationKey,
      new AbortController().signal
    )
  ).toBe(1)
  if (!preWrite) {
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2))
  }
  await vi.waitFor(() =>
    expect(f.journal.submission(targetSubmissionId)?.dispatchState).toBe(
      preWrite ? 'rejected' : 'unknown'
    )
  )
  await f.flush()
  const view = () =>
    readConversationTransferIntentions({
      db: f.db,
      stateDirectory: f.claimsHost.stateDirectory,
      conversationId: conversation.conversationId,
      currentRuntimeFence: (proof) => f.store.conversations.currentTransferRecoveryFence(proof)
    }).intentions.find((entry) => entry.transferId === transferId)
  const request = (action: ConversationTransferRecoveryAction) => {
    const scope = view()?.scope
    if (!scope) {
      throw new Error(`Continuation recovery scope missing: ${JSON.stringify(view())}`)
    }
    return { ...scope, action, clientOperationId: hostTestOperationId() }
  }
  const original = () =>
    readPinnedQueuedMessageEvidence(f.db, {
      ownerId: `conversation-transfer:${transferId}`,
      sourceSessionId: f.request.queueSessionId,
      messageId: draft.messageId,
      fingerprint: draft.fingerprint
    })
  return {
    ...f,
    claude,
    draft,
    parent,
    parentTransfer,
    parentOperation,
    parentReceipt,
    conversation,
    transferId,
    targetSubmissionId,
    view,
    request,
    original
  }
}

it.each(['return-held-draft', 'cancel-retain'] as const)(
  'recovers only a proven-unsent continuation with %s, preserving its accepted parent',
  async (action) => {
    const f = await fixture()
    expect(f.view()).toMatchObject({
      kind: 'queued-continuation',
      status: 'message-not-sent',
      actions: ['return-held-draft', 'cancel-retain'],
      original: { text: 'second intention 日本語🙂', truncated: false }
    })
    const pinned = f.original()
    const request = f.request(action)
    const first = await f.host.recoverConversationTransfer(request, CALLER.callerKey)
    expect(await f.host.recoverConversationTransfer(request, CALLER.callerKey)).toEqual(first)
    expect(f.store.conversations.intent(f.parent.operationKey)).toEqual(f.parent)
    expect(f.store.conversations.read(f.conversation.conversationId)).toEqual({
      ...f.conversation,
      revision: f.conversation.revision + 1
    })
    expect(readConversationTransfer(f.db, f.transferId)?.state).toBe('cancelled')
    expect(readConversationTransfer(f.db, 'fixture-transfer')).toEqual(f.parentTransfer)
    expect(
      f.store
        .listOperationRows()
        .find(
          (row) =>
            agentSessionOperationKey(row.callerKey, row.operationId) === f.parent.operationKey
        )
    ).toEqual(f.parentOperation)
    expect(
      f.db
        .prepare('SELECT evidence_json FROM conversation_delivery_receipts WHERE receipt_id=?')
        .get(f.parent.deliveryReceiptId)?.evidence_json
    ).toBe(f.parentReceipt)
    expect(f.journal.submission('fixture-trigger-submission')?.dispatchState).toBe('accepted')
    expect(f.journal.submission(f.targetSubmissionId)).toBeUndefined()
    expect(f.original()).toEqual(pinned)
    expect(
      f.source.queuedMessages.list().filter((card) => card.messageId === f.draft.messageId)
    ).toHaveLength(1)
    expect(f.source.queuedMessages.get(f.draft.messageId)).toMatchObject({
      body: f.draft.body,
      options: f.draft.options,
      position: f.draft.position,
      queuedAt: f.draft.queuedAt,
      state: action === 'return-held-draft' ? 'waiting' : 'withdrawn',
      holdReason: action === 'return-held-draft' ? 'send_failed' : null
    })
    expect(f.view()?.status).toBe(
      action === 'return-held-draft' ? 'returned-held' : 'cancelled-retained'
    )
    expect(
      await drainConversationContinuations(
        {
          db: f.db,
          stateDirectory: f.claimsHost.stateDirectory,
          deliveryHost: f.deliveryHost,
          publishSourceQueue: () => {},
          now: () => 3
        },
        f.parent.operationKey,
        new AbortController().signal
      )
    ).toBe(0)
    expect(f.claude.connections[0]?.sent).toHaveLength(1)
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  }
)

it('does not offer return or cancellation when a continuation native write is uncertain', async () => {
  const f = await fixture(false)
  expect(f.view()).toMatchObject({
    kind: 'queued-continuation',
    status: 'delivery-uncertain',
    actions: [],
    scope: null
  })
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
  expect(f.store.conversations.intent(f.parent.operationKey)).toEqual(f.parent)
  expect(f.store.conversations.read(f.conversation.conversationId)).toEqual(f.conversation)
  expect(f.claude.connections[0]?.sent).toHaveLength(2)
})

it('late native acceptance invalidates an already captured continuation recovery request', async () => {
  const f = await fixture()
  const request = f.request('return-held-draft')
  await f.journal.resolveDispatch({
    clientMessageId: f.targetSubmissionId,
    state: 'accepted',
    providerIdentity: null,
    fence: f.acquisition.fence
  })
  await expect(f.host.recoverConversationTransfer(request, CALLER.callerKey)).rejects.toThrow()
  expect(f.view()?.actions).toEqual([])
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
  expect(f.store.conversations.intent(f.parent.operationKey)).toEqual(f.parent)
  expect(f.store.conversations.read(f.conversation.conversationId)).toEqual(f.conversation)
})
