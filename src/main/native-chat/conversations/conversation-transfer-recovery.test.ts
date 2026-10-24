import { isConversationTransferRecoveryOwner } from './conversation-transfer-recovery-authority'
import { readHistoricalConversationTransferNoWrite } from './conversation-transfer-no-write'
import { call } from '../../runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { CONVERSATION_TRANSFER_RECOVERY_METHODS } from '../../runtime/rpc/methods/conversation-transfer-recovery-methods'
import { setStructuredAgentSessionHost } from '../agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES } from '../../../shared/structured-agent-session-renderer-client-capabilities'
import {
  NATIVE_CONVERSATION_READ_CAPABILITY,
  NATIVE_CONVERSATION_RUNTIME_CAPABILITY
} from '../../../shared/conversation-runtime-capabilities'
import { triggerClaimsFixture } from './conversation-trigger-claims.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../agent-session-wire/structured-agent-session-host-test-data'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from '../agent-session-wire/structured-agent-session-host'
import {
  CALLER,
  hostTestState,
  replaceHostTestState
} from '../agent-session-wire/structured-agent-session-host-test-harness'
import { recoverConversationTransfer } from './conversation-transfer-recovery'
import { assertConversationOriginsResolved } from './conversation-origin-rows'
import { conversationContextDigest } from './conversation-context-consent'
import { afterEach, expect, it, vi } from 'vitest'
import {
  fakeClaude,
  adapterAtPublishFor,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { nativeTriggerFixture } from '../agent-session-wire/structured-conversation-native-trigger.fixture'
import { AgentSessionPreDispatchError } from '../agent-session-wire/structured-agent-session-operation-settlement'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { readConversationTransferIntentions } from './conversation-transfer-recovery-view'
import { readConversationTransfer } from './conversation-trigger-reservation'
import type { ConversationTransferRecoveryAction } from '../../../shared/conversation-transfer-recovery'

const close: (() => Promise<void>)[] = []
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  for (const cleanup of close.splice(0).toReversed()) {
    await cleanup()
  }
})

async function fixture(
  noWrite = true,
  createBody?: Parameters<typeof nativeTriggerFixture>[2],
  sourceOptions?: Record<string, string>
) {
  const f = await nativeTriggerFixture(
    {
      handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
      params: {
        agent: 'claude',
        provider: 'claude',
        providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
        options: { model: 'opus' }
      }
    },
    undefined,
    createBody,
    sourceOptions
  )
  const claude = fakeClaude({
    initProof: 'none',
    replayUuid: null,
    initModels: [{ value: 'opus' }]
  })
  const adapter = adapterAtPublishFor(claude, {}, [], [], undefined, undefined, undefined, f.settle)
  close.push(async () => {
    await adapter.closeAll()
  })
  const acquired = await adapter.acquire({ ...f.acquisition, onSpawned: undefined })
  await adapter.open({
    sessionId: f.targetId,
    fence: f.acquisition.fence,
    acquisitionGeneration: acquired.acquisitionGeneration!,
    signal: new AbortController().signal
  })
  f.dispatch.mockImplementation((input) =>
    noWrite
      ? adapter.dispatch(input)
      : Promise.resolve({ state: 'unknown', reason: 'delivery uncertain' })
  )
  f.host.deps.bindConversationEvidencePlan = async () => {
    if (noWrite) {
      throw new AgentSessionPreDispatchError('candidate-context-unverified')
    }
    throw new Error('unproven failure')
  }
  await f.append()
  await vi.waitFor(() =>
    expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).not.toBe('pending')
  )
  await f.flush()
  const view = () =>
    readConversationTransferIntentions({
      db: f.db,
      stateDirectory: f.host.deps.journalDatabase.stateDirectory,
      currentRuntimeFence: (proof) => f.store.conversations.currentTransferRecoveryFence(proof),
      conversationId: f.intent.conversationId
    })
  const recoveryRequest = (
    action: ConversationTransferRecoveryAction = 'return-held-draft',
    suffix = '1'
  ) => {
    const scope = view().intentions[0]?.scope
    if (!scope) {
      throw new Error('Recovery scope missing')
    }
    return { ...scope, action, clientOperationId: `${Date.now()}-${suffix.repeat(32)}` }
  }
  const original = () =>
    readPinnedQueuedMessageEvidence(f.db, {
      ownerId: `conversation-transfer:${f.request.transferId}`,
      sourceSessionId: f.request.queueSessionId,
      messageId: f.request.messageId,
      fingerprint: f.draft.fingerprint
    })
  return { ...f, claude, adapter, view, recoveryRequest, original }
}

it('shows the real prewrite refusal and atomically returns exactly one held original without sending', async () => {
  const f = await fixture()
  expect(f.view().intentions[0]).toMatchObject({
    status: 'message-not-sent',
    actions: ['return-held-draft', 'cancel-retain'],
    original: { text: 'original triggering intent', truncated: false }
  })
  const pinned = f.original()
  const request = f.recoveryRequest()
  const first = await f.host.recoverConversationTransfer(request, 'caller')
  expect(await f.host.recoverConversationTransfer(request, 'caller')).toEqual(first)
  expect(f.source.queuedMessages.get(f.draft.messageId)).toMatchObject({
    body: f.draft.body,
    position: f.draft.position,
    queuedAt: f.draft.queuedAt,
    state: 'waiting',
    holdReason: 'send_failed',
    consumedAs: null
  })
  expect(
    f.source.queuedMessages.list().filter((card) => card.messageId === f.draft.messageId)
  ).toHaveLength(1)
  expect(f.original()).toEqual(pinned)
  expect(readConversationTransfer(f.db, request.transferId)?.state).toBe('cancelled')
  expect(f.store.conversations.read(f.intent.conversationId)?.pendingOperationKey).toBeNull()
  expect(f.journal.submission(f.request.targetSubmissionId)).toBeUndefined()
  expect(f.view().intentions[0]).toMatchObject({
    status: 'returned-held',
    actions: [],
    original: { text: 'original triggering intent' }
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(f.claude.connections[0]?.sent).toEqual([])
  expect(
    f.db.prepare('SELECT COUNT(*) total FROM conversation_transfer_recoveries').get()?.total
  ).toBe(1)
})

it('racing return and cancel-retain have one winner and preserve the immutable original', async () => {
  const f = await fixture()
  const held = f.recoveryRequest(),
    cancel = f.recoveryRequest('cancel-retain', '2')
  const results = await Promise.allSettled([
    f.host.recoverConversationTransfer(held, 'caller'),
    f.host.recoverConversationTransfer(cancel, 'caller')
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect(f.original()?.body).toEqual(f.draft.body)
  expect(
    f.db.prepare('SELECT COUNT(*) total FROM conversation_transfer_recoveries').get()?.total
  ).toBe(1)
  expect(f.claude.connections[0]?.sent).toEqual([])
})

it('cancel-retain clears the switch without restoring or deleting its original', async () => {
  const f = await fixture()
  await f.host.recoverConversationTransfer(f.recoveryRequest('cancel-retain'), 'caller')
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
  expect(f.store.conversations.read(f.intent.conversationId)?.pendingOperationKey).toBeNull()
  expect(f.view().intentions[0]).toMatchObject({
    status: 'cancelled-retained',
    actions: [],
    original: { text: 'original triggering intent' }
  })
  expect(f.original()?.body).toEqual(f.draft.body)
})

it('unknown failures never advertise recovery actions or resurrect the source', async () => {
  const f = await fixture(false)
  expect(f.view().intentions[0]).toMatchObject({
    status: 'delivery-uncertain',
    actions: [],
    scope: null,
    original: { text: 'original triggering intent' }
  })
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
})

it('late accepted dispatch beats an already captured no-write recovery request', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  await f.journal.resolveDispatch({
    clientMessageId: f.request.targetSubmissionId,
    state: 'accepted',
    providerIdentity: null,
    fence: f.acquisition.fence
  })
  await expect(f.host.recoverConversationTransfer(request, 'caller')).rejects.toThrow()
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
  expect(f.view().intentions[0]?.actions).toEqual([])
  expect(f.original()?.body).toEqual(f.draft.body)
})

it('missing proof refuses a captured request while retaining the original preview', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  f.db
    .prepare('DELETE FROM conversation_transfer_no_write WHERE transfer_id=?')
    .run(request.transferId)
  await expect(f.host.recoverConversationTransfer(request, 'caller')).rejects.toThrow()
  expect(f.view().intentions[0]).toMatchObject({
    actions: [],
    original: { text: 'original triggering intent' }
  })
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
})

it('a changed context generation refuses recovery rather than copying an old draft forward', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  f.db
    .prepare(
      "UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2,'$.revision',99) WHERE conversation_id=?"
    )
    .run(f.intent.conversationId)
  await expect(f.host.recoverConversationTransfer(request, 'caller')).rejects.toThrow()
  expect(f.view().intentions[0]).toMatchObject({
    actions: [],
    original: { text: 'original triggering intent' }
  })
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
})

it('reopening the store retains proof and preview but never mistakes persisted live lease for a reconciled owner', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  const reopened = await openTestAgentSessionRecordStore(f.host.deps.journalDatabase.stateDirectory)
  expect(reopened.getRecord(f.targetId)?.lease.unreconciled).toBe(true)
  const view = readConversationTransferIntentions({
    db: f.db,
    stateDirectory: f.host.deps.journalDatabase.stateDirectory,
    conversationId: f.intent.conversationId,
    currentRuntimeFence: (proof) => reopened.conversations.currentTransferRecoveryFence(proof)
  })
  expect(view.intentions[0]).toMatchObject({
    status: 'message-not-sent',
    actions: [],
    original: { text: 'original triggering intent' }
  })
  const openJournal = vi.fn(async () => f.source)
  await expect(
    recoverConversationTransfer({
      db: f.db,
      stateDirectory: f.host.deps.journalDatabase.stateDirectory,
      store: reopened.conversations,
      request,
      callerKey: 'caller',
      openJournal,
      isCurrent: () => true
    })
  ).rejects.toThrow()
  expect(openJournal).not.toHaveBeenCalled()
})

it('a new host replays committed return without restoring or sending it twice and reopens a held journal card', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  const result = await f.host.recoverConversationTransfer(request, 'caller')
  await f.host.flushAllStreamedEvents()
  const store = await openTestAgentSessionRecordStore(f.host.deps.journalDatabase.stateDirectory)
  const host = new StructuredAgentSessionHost({ ...f.host.deps, store })
  replaceHostTestState({ store, host })
  expect(await host.recoverConversationTransfer(request, 'caller')).toEqual(result)
  await host.journalSnapshot(f.request.queueSessionId)
  const source = host.collaboratorsForTests().sessions.get(f.request.queueSessionId)!.journal
  expect(source.queuedMessages.get(f.draft.messageId)).toMatchObject({
    state: 'waiting',
    holdReason: 'send_failed',
    body: f.draft.body
  })
  expect(
    source.queuedMessages.list().filter((card) => card.messageId === f.draft.messageId)
  ).toHaveLength(1)
  expect(
    f.db.prepare('SELECT COUNT(*) total FROM conversation_transfer_recoveries').get()?.total
  ).toBe(1)
  expect(f.claude.connections[0]?.sent).toEqual([])
})

it('retains complete text and managed attachments while projecting a labelled bounded preview', async () => {
  const full = 'Full original 🌿 '.repeat(600)
  const sourceOptions = { model: 'source-model', effort: 'high' }
  const f = await fixture(
    true,
    async (_directory, storeFile) => ({
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: full },
        {
          type: 'image-ref',
          path: await storeFile('image.png', 'unchanged bytes'),
          mimeType: 'image/png'
        }
      ]
    }),
    sourceOptions
  )
  const intention = f.view().intentions[0]!
  expect(intention.original).toMatchObject({
    truncated: true,
    attachmentCount: 1,
    bodyDigest: conversationContextDigest(f.draft.body)
  })
  expect(intention.original?.text.length).toBeLessThanOrEqual(4096)
  expect(intention.original?.bodyBytes).toBe(Buffer.byteLength(JSON.stringify(f.draft.body)))
  await f.host.recoverConversationTransfer(f.recoveryRequest(), 'caller')
  expect(f.source.queuedMessages.get(f.draft.messageId)?.body).toEqual(f.draft.body)
  expect(f.original()?.body).toEqual(f.draft.body)
  expect(f.original()?.options).toEqual(sourceOptions)
  expect(f.source.queuedMessages.get(f.draft.messageId)?.options).toEqual(sourceOptions)
})

it('pages more than eight retained intentions deterministically and rejects a cross-conversation cursor', async () => {
  const f = await fixture()
  const transfer = readConversationTransfer(f.db, f.request.transferId)!
  for (let n = 0; n < 10; n++) {
    const operationKey = `older-${n}`
    f.db
      .prepare('INSERT INTO conversation_switch_intents VALUES(?,?,?)')
      .run(operationKey, f.intent.conversationId, JSON.stringify({ ...f.intent, operationKey }))
    const binding = {
      ...transfer.binding,
      operationKey,
      transferId: `transfer-${n}`,
      messageId: `draft-${n}`,
      targetSubmissionId: `target-${n}`
    }
    f.db
      .prepare("INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,'uncertain')")
      .run(
        binding.transferId,
        binding.kind,
        operationKey,
        binding.queueSessionId,
        binding.messageId,
        binding.targetSessionId,
        binding.targetSubmissionId,
        JSON.stringify(binding)
      )
  }
  const first = f.view()
  expect(first.intentions).toHaveLength(8)
  expect(first.next).not.toBeNull()
  const second = readConversationTransferIntentions({
    db: f.db,
    stateDirectory: f.host.deps.journalDatabase.stateDirectory,
    conversationId: f.intent.conversationId,
    before: first.next,
    currentRuntimeFence: (proof) => f.store.conversations.currentTransferRecoveryFence(proof)
  })
  expect(second.intentions).toHaveLength(3)
  expect(second.next).toBeNull()
  expect(
    new Set([...first.intentions, ...second.intentions].map((entry) => entry.transferId)).size
  ).toBe(11)
  expect(() =>
    readConversationTransferIntentions({
      db: f.db,
      stateDirectory: f.host.deps.journalDatabase.stateDirectory,
      conversationId: 'other',
      before: first.next,
      currentRuntimeFence: () => null
    })
  ).toThrow()
})

it('return leaves exact historical provenance resolved for a fresh preparation', async () => {
  const f = await fixture()
  await f.host.recoverConversationTransfer(f.recoveryRequest(), 'caller')
  expect(() =>
    assertConversationOriginsResolved(f.db, f.intent.conversationId, f.intent.contextGeneration)
  ).not.toThrow()
})

it('missing target origin rolls the complete recovery transaction back', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  const proof = f.db
    .prepare('SELECT proof_json FROM conversation_transfer_no_write WHERE transfer_id=?')
    .get(request.transferId)
  const saved = JSON.parse(String(proof?.proof_json))
  f.db
    .prepare(
      "UPDATE conversation_origin_rows SET origin_json=NULL WHERE session_id=? AND epoch=? AND sequence=? AND atom_path='$'"
    )
    .run(f.targetId, saved.targetEpoch, saved.targetSubmissionSequence)
  await expect(f.host.recoverConversationTransfer(request, 'caller')).rejects.toThrow(
    'Retired submission origin unavailable'
  )
  expect(f.source.queuedMessages.get(f.draft.messageId)?.state).toBe('withdrawn')
  expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('rejected')
  expect(readConversationTransfer(f.db, request.transferId)?.state).toBe('appended')
  expect(
    f.db.prepare('SELECT count(*) total FROM conversation_transfer_recoveries').get()?.total
  ).toBe(0)
  expect(f.original()?.body).toEqual(f.draft.body)
})

it('restart reconciliation and native reacquisition permit held return with fresh authority, never the old fence', async () => {
  const f = await fixture(),
    stale = f.recoveryRequest()
  const store = await openTestAgentSessionRecordStore(f.host.deps.journalDatabase.stateDirectory)
  const host = new StructuredAgentSessionHost({
    ...f.host.deps,
    store,
    probeOwner: async () => ({ outcome: 'pid-absent' })
  })
  replaceHostTestState({ store, host })
  await host.reconcileRestartLeases()
  expect(store.getRecord(f.targetId)?.lease).toMatchObject({
    unreconciled: false,
    claimStatus: 'released'
  })
  const current = store.getRecord(f.targetId)!
  const acquired = hostTestState().acquire.getMockImplementation()!
  hostTestState().acquire.mockImplementation(async (input) => {
    const result = await acquired(input)
    return {
      ...result,
      process: result.process && {
        ...result.process,
        spawnToken: store.getRecord(input.identity.sessionId)!.lease.reservedSpawnToken!
      },
      link: result.link && { ...result.link, origin: 'resumed' }
    }
  })
  const attached = await host.attach(
    CALLER,
    hostTestAttachParams(current.lease.runtimeFence, {
      envelope: {
        sessionId: f.targetId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: current.lease.runtimeFence,
        payloadFingerprint: ''
      },
      agent: 'claude',
      provider: 'claude',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
      options: { model: 'opus' }
    })
  )
  expect(attached).toMatchObject({ ok: true })
  await expect(host.recoverConversationTransfer(stale, 'caller')).rejects.toThrow()
  const view = readConversationTransferIntentions({
    db: f.db,
    stateDirectory: host.deps.journalDatabase.stateDirectory,
    conversationId: f.intent.conversationId,
    currentRuntimeFence: (proof) => store.conversations.currentTransferRecoveryFence(proof)
  })
  expect(view.intentions[0]?.actions).toEqual(['return-held-draft', 'cancel-retain'])
  const scope = view.intentions[0]!.scope!
  expect(scope.expectedRuntimeFence).toBeGreaterThan(stale.expectedRuntimeFence)
  await host.recoverConversationTransfer(
    { ...scope, action: 'return-held-draft', clientOperationId: hostTestOperationId() },
    'caller'
  )
  const source = host.collaboratorsForTests().sessions.get(f.request.queueSessionId)!.journal
  expect(source.queuedMessages.get(f.draft.messageId)).toMatchObject({
    state: 'waiting',
    holdReason: 'send_failed',
    body: f.draft.body
  })
  expect(f.claude.connections[0]?.sent).toEqual([])
})

it('a held return allows an explicitly new switch and fresh preparation without reusing its old target attempt', async () => {
  const f = await fixture()
  await f.host.recoverConversationTransfer(f.recoveryRequest(), 'caller')
  const conversation = f.store.conversations.read(f.intent.conversationId)!
  const begun = await f.store.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      expectedNativeBindingGeneration: 1,
      target: f.store.getRecord(f.targetId)!
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'new-explicit-switch',
      now: 1800000000000
    }
  )
  expect(begun.intent).not.toBeNull()
  const prepared = await triggerClaimsFixture(undefined, undefined, async () => ({
    host: f.host,
    store: f.store,
    targetId: f.targetId,
    intent: begun.intent!
  }))
  expect(prepared.plan.operationKey).toBe(begun.intent!.operationKey)
  expect(prepared.plan.planId).not.toBe(f.plan.planId)
  expect(f.journal.submission(f.request.targetSubmissionId)).toBeUndefined()
  expect(f.source.queuedMessages.get(f.draft.messageId)).toMatchObject({
    holdReason: 'send_failed',
    body: f.draft.body
  })
  expect(f.claude.connections[0]?.sent).toEqual([])
})

it('authenticated RPC replays one durable return after lost publication, while a read-only client receives no actions', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  setStructuredAgentSessionHost(f.host)
  const client = {
    clientKind: 'runtime' as const,
    clientId: 'authenticated-recovery',
    pairedDeviceId: 'paired-desktop-recovery',
    clientCapabilities: [...STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES]
  }
  const readOnly = await call(
    'conversation.transferIntentions',
    { conversationId: f.intent.conversationId },
    {
      ...client,
      clientCapabilities: [
        ...client.clientCapabilities.filter(
          (cap) => cap !== NATIVE_CONVERSATION_RUNTIME_CAPABILITY
        ),
        NATIVE_CONVERSATION_READ_CAPABILITY
      ]
    },
    {},
    CONVERSATION_TRANSFER_RECOVERY_METHODS
  )
  expect(readOnly).toMatchObject({
    result: {
      intentions: [{ actions: [], scope: null, original: { text: 'original triggering intent' } }]
    }
  })
  const publishConversationSurfaces = vi
    .fn()
    .mockRejectedValueOnce(new Error('publication lost'))
    .mockResolvedValue(undefined)
  const first = await call(
    'conversation.recoverTransfer',
    request,
    client,
    { publishConversationSurfaces },
    CONVERSATION_TRANSFER_RECOVERY_METHODS
  )
  expect(first).toHaveProperty('error')
  expect(f.source.queuedMessages.get(f.draft.messageId)?.holdReason).toBe('send_failed')
  const second = await call(
    'conversation.recoverTransfer',
    request,
    client,
    { publishConversationSurfaces },
    CONVERSATION_TRANSFER_RECOVERY_METHODS
  )
  expect(second).toMatchObject({
    result: { action: 'return-held-draft', transferId: request.transferId }
  })
  expect(
    f.source.queuedMessages.list().filter((card) => card.messageId === f.draft.messageId)
  ).toHaveLength(1)
  expect(
    f.db.prepare('SELECT count(*) total FROM conversation_transfer_recoveries').get()?.total
  ).toBe(1)
  expect(f.claude.connections[0]?.sent).toEqual([])
})

it('a reconciled-but-recovering previous owner is not current recovery authority', async () => {
  const f = await fixture(),
    request = f.recoveryRequest()
  const store = await openTestAgentSessionRecordStore(f.host.deps.journalDatabase.stateDirectory)
  await store.reconcileOnRestart({
    probe: async () => ({ outcome: 'indeterminate', reason: 'owner cannot be proved' }),
    now: 1800000000001
  })
  expect(store.getRecord(f.targetId)?.lease).toMatchObject({
    unreconciled: false,
    claimStatus: 'live',
    handoffStage: 'recovering'
  })
  const view = readConversationTransferIntentions({
    db: f.db,
    stateDirectory: f.host.deps.journalDatabase.stateDirectory,
    conversationId: f.intent.conversationId,
    currentRuntimeFence: (proof) => store.conversations.currentTransferRecoveryFence(proof)
  })
  expect(view.intentions[0]).toMatchObject({ status: 'message-not-sent', actions: [], scope: null })
  const openJournal = vi.fn(async () => f.source)
  await expect(
    recoverConversationTransfer({
      db: f.db,
      stateDirectory: f.host.deps.journalDatabase.stateDirectory,
      store: store.conversations,
      request,
      callerKey: 'caller',
      openJournal,
      isCurrent: () => true
    })
  ).rejects.toThrow()
  expect(openJournal).not.toHaveBeenCalled()
  expect(f.original()?.body).toEqual(f.draft.body)
})

it('source-only recovering or residual ownership cannot authorize held restoration beside a valid target', async () => {
  const f = await fixture()
  const proof = readHistoricalConversationTransferNoWrite(f.db, f.request.transferId)!
  const target = f.store.getRecord(f.targetId)!,
    source = f.store.getRecord(f.request.queueSessionId)!
  expect(isConversationTransferRecoveryOwner(target, proof, source)).toBe(true)
  expect(
    isConversationTransferRecoveryOwner(target, proof, {
      ...source,
      lease: { ...source.lease, handoffStage: 'recovering', unreconciled: false }
    })
  ).toBe(false)
  const released = {
    ...source,
    lease: {
      ...source.lease,
      claimStatus: 'released' as const,
      ownerProcess: null,
      reservedSpawnToken: null,
      handoffStage: null,
      unreconciled: false
    }
  }
  expect(isConversationTransferRecoveryOwner(target, proof, released)).toBe(true)
  expect(
    isConversationTransferRecoveryOwner(target, proof, {
      ...released,
      lease: { ...released.lease, ownerProcess: source.lease.ownerProcess }
    })
  ).toBe(false)
  expect(
    isConversationTransferRecoveryOwner(target, proof, {
      ...released,
      lease: { ...released.lease, reservedSpawnToken: 'residual-owner-token' }
    })
  ).toBe(false)
  expect(
    isConversationTransferRecoveryOwner(target, proof, {
      ...released,
      lease: { ...released.lease, handoffStage: 'recovering' }
    })
  ).toBe(false)
})
