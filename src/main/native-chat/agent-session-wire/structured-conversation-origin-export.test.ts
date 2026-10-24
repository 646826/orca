import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  fakeCodexAppServer,
  echoUserMessage
} from '../../codex/codex-structured-dispatch-test-support'
import { acquireReadyCodexForTest } from '../../codex/codex-structured-session-adapter-fixture'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import {
  pinJournalEpoch,
  releaseJournalEpochPins
} from '../agent-session-journal/journal-epoch-pins'
import { exportConversationContext } from '../conversations/conversation-context-export'
import { prepareConversationOriginSourceAtomReceipt } from '../conversations/conversation-origin-source-atoms'
import { readConversationRowOrigins } from '../conversations/conversation-origin-rows'
import { readConversationSourceSegmentId } from '../conversations/conversation-source-attribution'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { nativeTriggerFixture } from './structured-conversation-native-trigger.fixture'
import { beginFreshSwitch } from './structured-conversation-switch.test-fixture'
import { freezeConversationPreparationSources } from '../conversations/conversation-preparation-sources'
import { CALLER } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

async function capturedBatch(unknownTurn = false) {
  const f = await nativeTriggerFixture(undefined, beginFreshSwitch)
  const target = f.store.getRecord(f.targetId)!
  const native = agentSessionProviderHandleChainHead(target.providerHandleChain)!.handle
  const codex = fakeCodexAppServer({
    'thread/start': () => ({ thread: { id: native.nativeId } }),
    'thread/resume': () => ({ thread: { id: native.nativeId } }),
    'turn/start': () => ({ turn: { id: 'captured-turn' } })
  })
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
    onDispatchSettledLate: f.settle
  })
  await acquireReadyCodexForTest(adapter, { ...f.acquisition, onSpawned: undefined })
  f.dispatch.mockImplementation((input) => adapter.dispatch(input))
  try {
    await f.append()
    await vi.waitFor(() =>
      expect(codex.connections[0]!.calls.some((call) => call.method === 'turn/start')).toBe(true)
    )
    const connection = codex.connections[0]!
    connection.handlers.onNotification?.('turn/started', {
      threadId: native.nativeId,
      turn: { id: 'captured-turn' }
    })
    echoUserMessage(connection, {
      threadId: native.nativeId,
      turnId: 'captured-turn',
      itemId: 'captured-user',
      clientId: f.request.targetSubmissionId
    })
    await vi.waitFor(async () => {
      await f.flush()
      expect(await f.receipt()).not.toBeNull()
    })
    await f.activate()
    const turnId = unknownTurn ? 'unrelated-turn' : 'captured-turn'
    if (unknownTurn) {
      connection.handlers.onNotification?.('turn/completed', {
        threadId: native.nativeId,
        turn: { id: 'captured-turn', status: 'completed' }
      })
      await f.flush()
      connection.handlers.onNotification?.('turn/started', {
        threadId: native.nativeId,
        turn: { id: turnId }
      })
    }
    connection.handlers.onNotification?.('turn/completed', {
      threadId: native.nativeId,
      turn: { id: turnId, status: 'completed' }
    })
    await f.flush()
  } finally {
    await adapter.closeAll()
  }
  const batch = f.db
    .prepare(
      "SELECT epoch,seq,row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='lifecycle-batch' ORDER BY seq DESC"
    )
    .get(f.targetId)
  if (
    typeof batch?.row_json !== 'string' ||
    typeof batch.epoch !== 'string' ||
    typeof batch.seq !== 'number'
  ) {
    throw new Error('missing captured native lifecycle batch')
  }
  const source = { sessionId: f.targetId, epoch: batch.epoch, sequence: batch.seq }
  const raw = batch.row_json
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const pin = runJournalTransaction(f.db, () =>
    pinJournalEpoch(f.db, {
      ownerId: 'native-origin-export-test',
      sessionId: f.targetId,
      epoch: source.epoch,
      endSequence: source.sequence
    })
  )
  const prepare = () =>
    prepareConversationOriginSourceAtomReceipt(f.db, {
      pin,
      source,
      conversationId: f.intent.conversationId,
      contextGeneration: f.intent.contextGeneration,
      mutationCount: JSON.parse(raw).mutations.length
    })!
  const exportBatch = () =>
    exportConversationContext({
      db: f.db,
      stateDirectory: f.claimsHost.stateDirectory,
      store: new AgentSessionAttachmentStore(
        agentSessionAttachmentStoreRoot(f.claimsHost.stateDirectory),
        { hasSession: (id) => f.store.getRecord(id) !== null }
      ),
      conversationId: f.intent.conversationId,
      contextGeneration: f.intent.contextGeneration,
      sources: [
        {
          source,
          segmentId: readConversationSourceSegmentId(f.db, source)!,
          pinOwnerId: pin.ownerId,
          decision: 'include',
          critical: true
        }
      ],
      disclosure: {
        targetBindingDigest: 'a'.repeat(64),
        resolve: () => ({
          version: { source, sha256 },
          contextGeneration: f.intent.contextGeneration,
          targetBindingDigest: 'a'.repeat(64),
          action: 'include',
          reason: 'user-policy',
          critical: true
        })
      }
    })
  return { ...f, source, raw: batch.row_json, pin, prepare, exportBatch }
}

function expectNoProofs(f: Awaited<ReturnType<typeof capturedBatch>>) {
  expect(
    f.db
      .prepare('SELECT count(*) n FROM conversation_source_atoms WHERE session_id=?')
      .get(f.targetId)?.n
  ).toBe(0)
  expect(
    f.db
      .prepare(
        'SELECT count(*) n FROM conversation_source_versions WHERE session_id=? AND epoch=? AND sequence=?'
      )
      .get(f.source.sessionId, f.source.epoch, f.source.sequence)?.n
  ).toBe(0)
}

async function beginReturn(f: Awaited<ReturnType<typeof capturedBatch>>) {
  const conversation = f.store.conversations.read(f.intent.conversationId)!
  const target = f.store.getRecord(HOST_TEST_SESSION)!
  const begun = await f.store.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: conversation.contextGeneration,
      expectedActivationFence: conversation.activationFence,
      target,
      expectedNativeBindingGeneration: 1
    },
    {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'captured-return',
      now: HOST_TEST_NOW
    }
  )
  if (!begun.intent) {
    throw new Error('missing return switch')
  }
  return begun.intent
}

it('freezes exact lifecycle export authority from captured native atom origins without rewriting journal bytes', async () => {
  const f = await capturedBatch()
  const origins = readConversationRowOrigins(f.db, f.source)
  expect(origins.length).toBeGreaterThan(1)
  expect(origins.every(({ origin }) => origin.conversationId === f.intent.conversationId)).toBe(
    true
  )
  expectNoProofs(f)
  await expect(f.exportBatch()).rejects.toMatchObject({ code: 'scope' })
  await freezeConversationPreparationSources(
    f.db,
    await beginReturn(f),
    new AbortController().signal
  )
  const exported = await f.exportBatch()
  const row = exported.rows[0]!
  expect(
    (await readFile(exported.artifact.path))
      .subarray(row.byteOffset, row.byteOffset + row.byteLength)
      .toString()
  ).toBe(f.raw)
  expect(readConversationRowOrigins(f.db, f.source)).toEqual(origins)
  expect(
    f.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(f.source.sessionId, f.source.epoch, f.source.sequence)?.row_json
  ).toBe(f.raw)
  expect(
    f.db
      .prepare('SELECT count(*) n FROM conversation_source_atoms WHERE session_id=?')
      .get(f.targetId)?.n
  ).toBe(origins.length)
})

it('rolls back derived proofs and releases temporary pins when source provenance changes inside proof commit', async () => {
  const f = await capturedBatch()
  const returning = await beginReturn(f)
  const origins = readConversationRowOrigins(f.db, f.source)
  f.db.exec(`CREATE TRIGGER invalidate_captured_source BEFORE INSERT ON conversation_source_versions
    BEGIN UPDATE conversation_origin_acquisitions SET native_identity=native_identity WHERE session_id=NEW.session_id; END`)
  await expect(
    freezeConversationPreparationSources(f.db, returning, new AbortController().signal)
  ).rejects.toThrow('Preparation provenance changed')
  expectNoProofs(f)
  expect(readConversationRowOrigins(f.db, f.source)).toEqual(origins)
  expect(f.db.prepare('SELECT count(*) n FROM conversation_preparation_sources').get()?.n).toBe(0)
  expect(
    f.db
      .prepare(
        "SELECT count(*) n FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-preparation:%'"
      )
      .get()?.n
  ).toBe(0)
})

it('does not authorize an uncorrelated native lifecycle batch', async () => {
  const f = await capturedBatch(true)
  expect(() => f.prepare()).toThrow('conversation origin unresolved')
  expectNoProofs(f)
})

it.each(['origin-revoked', 'foreign-origin', 'pin-released', 'pin-changed'] as const)(
  'refuses %s between preparation and commit without publishing proofs',
  async (scenario) => {
    const f = await capturedBatch()
    const receipt = f.prepare()
    if (scenario === 'origin-revoked') {
      f.db
        .prepare(
          "DELETE FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? AND atom_path='$.mutations[0]'"
        )
        .run(f.source.sessionId, f.source.epoch, f.source.sequence)
    } else if (scenario === 'foreign-origin') {
      f.db
        .prepare(
          "UPDATE conversation_origin_rows SET origin_json=json_set(origin_json,'$.conversationId','foreign-conversation') WHERE session_id=? AND epoch=? AND sequence=? AND atom_path='$.mutations[0]'"
        )
        .run(f.source.sessionId, f.source.epoch, f.source.sequence)
      expect(() => f.prepare()).toThrow('identity mismatch')
    } else {
      runJournalTransaction(f.db, () => releaseJournalEpochPins(f.db, f.pin.ownerId))
      if (scenario === 'pin-changed') {
        runJournalTransaction(f.db, () =>
          pinJournalEpoch(f.db, { ...f.pin, endSequence: f.pin.endSequence - 1 })
        )
      }
    }
    expect(() => runJournalTransaction(f.db, () => receipt.write(f.db))).toThrow()
    expectNoProofs(f)
  }
)

it('rolls back canonical version and every atom when a proof write fails', async () => {
  const f = await capturedBatch()
  const receipt = f.prepare()
  f.db.exec(
    "CREATE TRIGGER refuse_captured_atom BEFORE INSERT ON conversation_source_atoms WHEN NEW.atom_path='$.mutations[0]' BEGIN SELECT RAISE(ABORT,'captured proof unavailable'); END"
  )
  expect(() => runJournalTransaction(f.db, () => receipt.write(f.db))).toThrow(
    'captured proof unavailable'
  )
  expectNoProofs(f)
})
