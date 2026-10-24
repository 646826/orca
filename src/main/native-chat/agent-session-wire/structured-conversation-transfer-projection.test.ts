import { createConversationCanonicalRowValidator } from '../conversations/conversation-canonical-row-validation'
import { readConversationTransportSubmission } from '../conversations/conversation-transport-submission'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { validateConversationContextEvidence } from '../conversations/conversation-context-evidence'
import type { ConversationContextInput } from '../../../shared/conversation-handoff'
import { createHash } from 'node:crypto'
import {
  projectConversationTransportRow,
  verifyConversationTransportProjection
} from '../conversations/conversation-transport-projection'
import { beginFreshSwitch } from './structured-conversation-switch.test-fixture'
import { readConversationSourceSegmentId } from '../conversations/conversation-source-attribution'
import { expect, it, vi } from 'vitest'
import { triggerClaimsFixture } from '../conversations/conversation-trigger-claims.test-fixture'
import { prepareConversationTrigger } from '../conversations/conversation-trigger-claims'
import { appendConversationTransfer } from './structured-conversation-source-queue'
import { finalizeConversationDeliveryReceipt } from '../conversations/conversation-delivery-receipt'
import { createConversationPreparationService } from '../conversations/conversation-preparation-service'
import { approveConversationPreparationRequest } from '../conversations/conversation-preparation-request'
import { conversationContextDigest } from '../conversations/conversation-context-consent'
import {
  assertConversationManifestPartAuthority,
  conversationContextAccountDigest
} from '../conversations/conversation-context-authority'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { hostTestState, CALLER } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { fakeCodexAppServer } from '../../codex/codex-structured-dispatch-test-support'
import { acquireReadyCodexForTest } from '../../codex/codex-structured-session-adapter-fixture'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'

it('projects the original user trigger, not its prior transport envelope, when returning A → B → A', async () => {
  const original = hostTestMessage(
    'Keep Unicode: 日本語🙂. historicalEvidence is literal user text.'
  )
  const f = await triggerClaimsFixture(async () => original, undefined, beginFreshSwitch)
  const signal = new AbortController().signal
  const prepared = await prepareConversationTrigger(f.db, f.request, f.claimsHost, 1, signal)
  await f.store.conversations.progress({
    operationKey: f.intent.operationKey,
    expectedVersion: f.intent.version,
    phase: 'delivering',
    sourceBoundaries: f.intent.sourceBoundaries,
    manifestId: f.manifest.manifestId,
    deliveryReceiptId: null
  })
  f.host.deps.conversationTransferAuthority = prepared.authority
  f.host.deps.conversationDeliveryHost = f.deliveryHost
  const target = f.store.getRecord(f.targetId)!
  const native = agentSessionProviderHandleChainHead(target.providerHandleChain)!.handle
  if (native.agent !== 'codex') {
    throw new Error('fixture native kind')
  }
  const codex = fakeCodexAppServer({
    'thread/start': () => ({ thread: { id: native.nativeId } }),
    'thread/resume': () => ({ thread: { id: native.nativeId } }),
    'turn/start': () => ({ turn: { id: 'transfer-turn' } })
  })
  const settlements: Promise<void>[] = []
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1700000000000,
    now: () => 1700000000500,
    onDispatchSettledLate: (value) => {
      settlements.push(f.host.settleLateDispatch(value))
    }
  })
  const acquired = hostTestState().acquire.mock.calls.findLast(
    ([input]) => input.identity.sessionId === f.targetId
  )?.[0]
  if (!acquired) {
    throw new Error('missing target acquire')
  }
  await acquireReadyCodexForTest(adapter, { ...acquired, onSpawned: undefined })
  f.dispatch.mockImplementation((input) => adapter.dispatch(input))
  try {
    const journal = f.host.collaboratorsForTests().sessions.get(f.targetId)!.journal
    await appendConversationTransfer({
      db: f.db,
      source: f.source,
      target: journal,
      binding: prepared.binding,
      authority: prepared.authority,
      body: prepared.body,
      options: prepared.options,
      fence: target.lease.runtimeFence,
      now: 1,
      isCurrent: (entry) => f.deliveryHost.getJournal(entry.queuedMessages.sessionId) === entry
    })
    await vi.waitFor(() =>
      expect(codex.connections[0]!.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1)
    )
    const connection = codex.connections[0]!
    connection.handlers.onNotification?.('turn/started', {
      threadId: native.nativeId,
      turn: { id: 'transfer-turn' }
    })
    connection.handlers.onNotification?.('item/started', {
      threadId: native.nativeId,
      turn: { id: 'transfer-turn' },
      item: {
        type: 'userMessage',
        id: 'transfer-item',
        clientId: prepared.binding.targetSubmissionId,
        content: prepared.body.blocks
      }
    })
    await vi.waitFor(() => expect(settlements.length).toBeGreaterThan(0))
    await Promise.all(settlements)
    await f.host.flushStreamedEvents(f.targetId)
    const delivery = await finalizeConversationDeliveryReceipt(
      f.db,
      f.plan.planId,
      f.deliveryHost,
      signal
    )
    if (!delivery) {
      throw new Error('missing verified native delivery receipt')
    }
    const current = f.store.conversations.intent(f.intent.operationKey)!
    const ready = await f.store.conversations.progress({
      operationKey: current.operationKey,
      expectedVersion: current.version,
      phase: 'delivering',
      sourceBoundaries: delivery.sourceBoundaries,
      candidateBoundary: delivery.candidateBoundary,
      manifestId: f.manifest.manifestId,
      deliveryReceiptId: delivery.deliveryReceiptId
    })
    const before = f.store.conversations.read(f.intent.conversationId)!
    await f.store.conversations.activate({
      operationKey: ready.operationKey,
      expectedVersion: ready.version,
      expectedRevision: before.revision,
      expectedContextGeneration: before.contextGeneration,
      expectedActivationFence: before.activationFence,
      expectedNativeBindingGeneration: ready.nativeBindingGeneration,
      deliveryReceiptId: delivery.deliveryReceiptId,
      sourceBoundaries: delivery.sourceBoundaries
    })
    connection.handlers.onNotification?.('turn/completed', {
      threadId: native.nativeId,
      turn: { id: 'transfer-turn', status: 'completed' }
    })
    await f.host.flushStreamedEvents(f.targetId)
    expect(f.store.conversations.route(f.targetId).role).toBe('active')
    const conversation = f.store.conversations.read(f.intent.conversationId)!
    const returning = f.store.getRecord(HOST_TEST_SESSION)!
    const begun = await f.store.conversations.beginSwitch(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        target: returning,
        expectedNativeBindingGeneration: 1
      },
      {
        callerKey: CALLER.callerKey,
        operationId: hostTestOperationId(),
        fingerprint: 'return',
        now: HOST_TEST_NOW
      }
    )
    if (!begun.intent) {
      throw new Error(`return switch missing: ${JSON.stringify(begun)}`)
    }
    const intent = begun.intent
    const contextTarget = {
      sessionId: HOST_TEST_SESSION,
      provider: returning.provider,
      accountBindingDigest: conversationContextAccountDigest(returning),
      nativeBindingGeneration: intent.nativeBindingGeneration,
      capabilityFingerprint: 'synthetic-return-budget',
      model: 'synthetic-model',
      retrieval: 'unsupported' as const
    }
    const service = createConversationPreparationService({
      db: f.db,
      stateDirectory: f.claimsHost.stateDirectory,
      store: () =>
        new AgentSessionAttachmentStore(
          agentSessionAttachmentStoreRoot(f.claimsHost.stateDirectory),
          {
            hasSession: (id) => f.store.getRecord(id) !== null
          }
        ),
      readTarget: () => ({
        target: contextTarget,
        budget: {
          capacity: 1000000,
          occupied: 0,
          reserved: 10000,
          confidence: 'upper-bound',
          targetFingerprint: contextTarget.capabilityFingerprint,
          nativeBindingGeneration: contextTarget.nativeBindingGeneration,
          model: contextTarget.model,
          accountBindingDigest: contextTarget.accountBindingDigest,
          observedAt: 1,
          validUntil: 100
        },
        nativeIdentityDigest: 'return-native',
        runtimeFence: returning.lease.runtimeFence,
        optionsDigest: 'return-options',
        freshNative: false
      }),
      now: () => 2,
      fullEstimator: () => ({
        countTokens: (text: string) => Buffer.byteLength(text),
        confidence: 'upper-bound'
      })
    })
    approveConversationPreparationRequest(
      f.db,
      {
        operationKey: intent.operationKey,
        expectedVersion: intent.version,
        expectedContextGeneration: intent.contextGeneration,
        targetSessionId: HOST_TEST_SESSION,
        targetBindingDigest: conversationContextDigest(contextTarget),
        capabilityFingerprint: contextTarget.capabilityFingerprint,
        policy: 'full',
        disclosure: 'available-canonical'
      },
      CALLER.callerKey
    )
    const readCanonical = () =>
      f.db
        .prepare('SELECT row_json FROM journal_rows WHERE session_id=? ORDER BY epoch,seq')
        .all(f.targetId)
    const canonical = readCanonical()
    const stored = canonical.find(
      (entry) =>
        typeof entry.row_json === 'string' &&
        JSON.parse(entry.row_json).clientMessageId === prepared.binding.targetSubmissionId &&
        JSON.parse(entry.row_json).kind === 'submission'
    )
    if (typeof stored?.row_json !== 'string') {
      throw new Error('canonical transfer submission missing')
    }
    const row = JSON.parse(stored.row_json)
    const version = {
      source: { sessionId: f.targetId, epoch: row.epoch, sequence: row.seq },
      sha256: createHash('sha256').update(stored.row_json).digest('hex')
    }
    const projected = projectConversationTransportRow(f.db, intent, version, stored.row_json)!
    expect(JSON.parse(projected.text!).body).toEqual(original)
    const part = {
      ...projected,
      version,
      representation: 'transport-projected' as const,
      spans: [{ version, startByte: 0, endByte: Buffer.byteLength(stored.row_json) }]
    }
    expect(verifyConversationTransportProjection(f.db, intent, part)).toBe(true)
    const validator = createConversationCanonicalRowValidator(
      f.db,
      intent,
      version.source,
      Buffer.byteLength(stored.row_json)
    )
    validator.write(`${stored.row_json.slice(0, -1)} `)
    expect(() => validator.end()).toThrow('corrupt-source')
    expect(verifyConversationTransportProjection(f.db, intent, { ...part, spans: [] })).toBe(false)
    const excessive = JSON.stringify({ ...row, body: hostTestMessage('x'.repeat(2 * 1024 * 1024)) })
    expect(
      projectConversationTransportRow(
        f.db,
        intent,
        {
          ...version,
          sha256: createHash('sha256').update(excessive).digest('hex')
        },
        excessive
      )
    ).toBeNull()
    await expect(
      f.source.queuedMessages.update({
        messageId: prepared.binding.messageId,
        expectedBodyFingerprint: prepared.binding.sourceFingerprint,
        text: 'changed after transfer'
      })
    ).resolves.toMatchObject({ status: 'gone', disposition: 'withdrawn' })
    f.db.exec('SAVEPOINT missing_transport_receipt')
    try {
      f.db
        .prepare('DELETE FROM conversation_delivery_receipts WHERE receipt_id=?')
        .run(f.store.conversations.intent(prepared.binding.operationKey)!.deliveryReceiptId)
      const prepare = vi.spyOn(f.db, 'prepare')
      try {
        expect(() => readConversationTransportSubmission(f.db, intent, version.source)).toThrow(
          'Transport projection acceptance is unavailable'
        )
        expect(
          prepare.mock.calls.some(([sql]) => sql.includes('CASE WHEN octet_length(row_json)'))
        ).toBe(false)
      } finally {
        prepare.mockRestore()
      }
      expect(verifyConversationTransportProjection(f.db, intent, part)).toBe(false)
    } finally {
      f.db.exec('ROLLBACK TO missing_transport_receipt; RELEASE missing_transport_receipt')
    }
    expect(
      verifyConversationTransportProjection(f.db, intent, {
        ...part,
        transportProjection: {
          transfers: [
            {
              transferId: prepared.binding.transferId,
              bodyPath: '/body',
              bindingDigest: '0'.repeat(64)
            }
          ]
        }
      })
    ).toBe(false)
    expect(
      verifyConversationTransportProjection(f.db, intent, {
        ...part,
        text: JSON.stringify({ ...row, body: hostTestMessage('changed original intent') })
      })
    ).toBe(false)
    const unrelated = JSON.stringify({ ...row, clientMessageId: 'ordinary-unrelated-message' })
    expect(
      projectConversationTransportRow(
        f.db,
        intent,
        {
          ...version,
          sha256: createHash('sha256').update(unrelated).digest('hex')
        },
        unrelated
      )
    ).toBeNull()
    for (const [field, value] of [
      ['segmentId', 'another-activation'],
      ['nativeBindingGeneration', 2],
      ['contextGeneration', 2]
    ]) {
      f.db.exec('SAVEPOINT corrupt_transport_origin')
      try {
        f.db
          .prepare(
            `UPDATE conversation_origin_rows SET origin_json=json_set(origin_json,?,?) WHERE session_id=? AND epoch=? AND sequence=?`
          )
          .run(`$.${field}`, value, f.targetId, row.epoch, row.seq)
        expect(
          verifyConversationTransportProjection(f.db, intent, part),
          `transport must not cross ${field}`
        ).toBe(false)
      } finally {
        f.db.exec('ROLLBACK TO corrupt_transport_origin; RELEASE corrupt_transport_origin')
      }
    }
    const result = await service.preparation.prepare(intent, null, signal, null)
    expect(result.kind).toBe('prepared')
    const saved = f.db
      .prepare('SELECT manifest_id FROM conversation_preparation_previews WHERE operation_key=?')
      .get(intent.operationKey)
    const preview = service.authority.readPreview(String(saved?.manifest_id))!
    expect(readCanonical()).toEqual(canonical)
    const submission = preview.manifest.projection.find((part) => {
      const row = JSON.parse(part.text ?? 'null')
      return (
        row?.kind === 'submission' && row.clientMessageId === prepared.binding.targetSubmissionId
      )
    })
    expect(submission, 'the exact original trigger must remain in return context').toBeDefined()
    expect(JSON.parse(submission!.text!).body).toEqual(original)
    expect(submission!.representation).toBe('transport-projected')
    const validation: ConversationContextInput = {
      ...preview.manifest,
      evidenceIndex: undefined,
      target: { ...preview.manifest.target, retrieval: 'verified' },
      projection: [submission!],
      originals: [
        {
          version,
          text: stored.row_json,
          artifactId: submission!.artifactId,
          kind: 'user',
          gaps: []
        }
      ],
      mandatory: [],
      countTokens: null,
      now: 2,
      signal,
      verifyTransportProjection: (source, projection) =>
        verifyConversationTransportProjection(f.db, intent, projection, source.text)
    }
    expect(validateConversationContextEvidence(validation)).toBeNull()
    expect(
      validateConversationContextEvidence({ ...validation, verifyTransportProjection: undefined })
    ).toMatchObject({ reason: 'invalid-provenance' })
    for (const representation of ['summarized', 'retrievable-only'] as const) {
      expect(
        validateConversationContextEvidence({
          ...validation,
          projection: [
            {
              ...submission!,
              representation,
              transportProjection: undefined,
              ...(representation === 'retrievable-only' ? { text: undefined } : {})
            }
          ]
        })
      ).toMatchObject({ reason: 'unsupported-representation' })
    }
    expect(validateConversationContextEvidence({ ...validation, projection: [] })).toMatchObject({
      reason: 'missing-representation'
    })
    expect(
      validateConversationContextEvidence({
        ...validation,
        projection: [{ ...submission!, representation: 'exact', transportProjection: undefined }]
      })
    ).toMatchObject({ reason: 'invalid-provenance' })

    expect(() =>
      assertConversationManifestPartAuthority(f.db, preview.manifest, {
        ...submission!,
        text: JSON.stringify({ ...row, body: hostTestMessage('forged user intent') })
      })
    ).toThrow('Transport projection authority is unverified')
    // Restored native echoes use the same journal appender and captured origin hook as provider history.
    const providerItemId = journal.receiptFor(prepared.binding.targetSubmissionId)?.providerItemId
    const identity = providerItemId && parseAgentJournalItemKey(providerItemId)
    const correlated = f.db
      .prepare(
        'SELECT turn_key FROM conversation_origin_correlations WHERE session_id=? AND submission_id=? AND resolved=1'
      )
      .get(f.targetId, prepared.binding.targetSubmissionId)
    if (!identity || typeof correlated?.turn_key !== 'string') {
      throw new Error('native echo identity missing')
    }
    const sender = { kind: 'agent' as const, senders: [], orchestration: null }
    const echoBody = { ...prepared.body, from: sender }
    await journal.appendItem(identity, echoBody, {
      fence: target.lease.runtimeFence,
      ownerFence: target.lease.runtimeFence,
      turnScope: { kind: 'turn', turnItemId: correlated.turn_key }
    })
    const echoed = f.db
      .prepare(
        "SELECT row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='item' AND json_extract(row_json,'$.itemId')=? ORDER BY seq DESC LIMIT 1"
      )
      .get(f.targetId, providerItemId)
    if (typeof echoed?.row_json !== 'string') {
      throw new Error('restored echo missing')
    }
    const echoRaw = echoed.row_json
    const echoRow = JSON.parse(echoRaw)
    const echoVersion = {
      source: { sessionId: f.targetId, epoch: echoRow.epoch, sequence: echoRow.seq },
      sha256: createHash('sha256').update(echoRaw).digest('hex')
    }
    const echoProjection = projectConversationTransportRow(f.db, intent, echoVersion, echoRaw)!
    expect(JSON.parse(echoProjection.text!).body).toEqual({ ...original, from: sender })
    const echoPart = {
      ...echoProjection,
      version: echoVersion,
      representation: 'transport-projected' as const,
      spans: [{ version: echoVersion, startByte: 0, endByte: Buffer.byteLength(echoRaw) }]
    }
    expect(verifyConversationTransportProjection(f.db, intent, echoPart)).toBe(true)
    for (const oversized of [
      { ...echoRow, body: hostTestMessage('x'.repeat(1024 * 1024)) },
      {
        ...echoRow,
        kind: 'lifecycle-batch',
        mutations: [{ ...echoRow, body: hostTestMessage('x'.repeat(1024 * 1024)) }]
      }
    ]) {
      const raw = JSON.stringify(oversized)
      expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024)
      expect(
        projectConversationTransportRow(
          f.db,
          intent,
          {
            ...echoVersion,
            sha256: createHash('sha256').update(raw).digest('hex')
          },
          raw
        )
      ).toBeNull()
    }

    for (const [field, value] of [
      ['segmentId', 'another-activation'],
      ['nativeBindingGeneration', 2]
    ]) {
      f.db.exec('SAVEPOINT reused_provider_item')
      try {
        f.db
          .prepare(
            'UPDATE conversation_origin_rows SET origin_json=json_set(origin_json,?,?) WHERE session_id=? AND epoch=? AND sequence=?'
          )
          .run(`$.${field}`, value, f.targetId, echoRow.epoch, echoRow.seq)
        expect(verifyConversationTransportProjection(f.db, intent, echoPart)).toBe(false)
      } finally {
        f.db.exec('ROLLBACK TO reused_provider_item; RELEASE reused_provider_item')
      }
    }
    for (const changed of [
      { ...echoRow, epoch: 'different-native-epoch' },
      { ...echoRow, ownerFence: target.lease.runtimeFence + 1 },
      { ...echoRow, turnScope: { kind: 'turn', turnItemId: 'different-native-turn' } }
    ]) {
      const raw = JSON.stringify(changed)
      expect(
        verifyConversationTransportProjection(
          f.db,
          intent,
          {
            ...echoPart,
            version: {
              source: { ...echoVersion.source, epoch: changed.epoch },
              sha256: createHash('sha256').update(raw).digest('hex')
            }
          },
          raw
        )
      ).toBe(false)
    }
    expect(() =>
      projectConversationTransportRow(
        f.db,
        intent,
        { ...echoVersion, source: { ...echoVersion.source, batchIndex: 0 } },
        echoRaw
      )
    ).toThrow('complete canonical row')
  } finally {
    await adapter.closeAll()
  }
})

it('attributes only the host-founded empty bootstrap epoch before later return preparation', async () => {
  const f = await beginFreshSwitch()
  const boundary = f.intent.candidateBaseline[0]!
  expect(
    readConversationSourceSegmentId(f.host.deps.journalDatabase.db, {
      sessionId: f.targetId,
      epoch: boundary.epoch,
      sequence: 1
    })
  ).toBe(f.intent.candidateSegmentId)
})
