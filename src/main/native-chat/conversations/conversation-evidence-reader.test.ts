import {
  readConversationManifest,
  recordConversationCoverage
} from './conversation-context-coverage'
import { conversationDeliveryEnvelope } from './conversation-delivery-plan'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConversationEvidenceFixture } from './conversation-evidence-reader.test-fixture'
import { openConversationEvidenceReader } from './conversation-evidence-reader'
import { readConversationCoverageRevision } from './conversation-context-authority-revision'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import { readConversationDeliveryReceipt } from './conversation-delivery-receipt'
import { prepareConversationTrigger } from './conversation-trigger-claims'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
let f: Awaited<ReturnType<typeof createConversationEvidenceFixture>>
beforeEach(async () => {
  f = await createConversationEvidenceFixture()
})
afterEach(() => f.fixture.close())
function open() {
  return openConversationEvidenceReader(
    {
      db: f.fixture.host.db,
      stateDirectory: f.fixture.host.stateDirectory,
      planId: f.plan.planId,
      host: f.host,
      acquisitionGeneration: 'acquired'
    },
    f.signal
  )
}
it('reads only immutable manifest members after final input, before activation', async () => {
  expect(
    conversationDeliveryEnvelope(
      readConversationManifest(f.fixture.host.db, f.manifest.manifestId)!,
      f.plan.inlineDeltaKeys
    )
  ).toBe(conversationDeliveryEnvelope(f.manifest, f.plan.inlineDeltaKeys))
  expect(open).toThrow()
  f.bind()
  const reader = open()
  try {
    const page = reader.list()
    expect(page.sources).toHaveLength(1)
    let cursor: string | undefined,
      text = ''
    do {
      const result = await reader.read({ source: page.sources[0]!.locator, cursor, maxBytes: 17 })
      text += result.text
      cursor = result.nextCursor ?? undefined
    } while (cursor)
    expect(text).toBe(f.original)
    await expect(reader.read({ source: '../secret' })).rejects.toThrow()
  } finally {
    await reader.close()
  }
})
it('revokes before bytes when source disclosure or current acquisition disappears', async () => {
  f.bind()
  const reader = open()
  const locator = reader.list().sources[0]!.locator
  f.host.canRetrieve = () => false
  await expect(reader.read({ source: locator })).rejects.toThrow()
  f.host.canRetrieve = () => true
  f.host.readAcquisition = () => null
  await expect(reader.read({ source: locator })).rejects.toThrow()
  await reader.close()
})
it('refuses membership whose immutable export claim was released', async () => {
  f.bind()
  const reader = open()
  const locator = reader.list().sources[0]!.locator
  f.fixture.host.db.prepare('DELETE FROM conversation_attachment_claims').run()
  await expect(reader.read({ source: locator })).rejects.toThrow()
  await reader.close()
})
it('resolves a sealed indexed member and refuses a different source locator', async () => {
  f.fixture.close()
  f = await createConversationEvidenceFixture(true)
  // Input binding revalidates current index authority via the real async observer.
  const { observeConversationNativeInput } = await import('./conversation-delivery-input')
  await observeConversationNativeInput(
    f.fixture.host.db,
    {
      planId: f.plan.planId,
      submissionId: 'trigger',
      observation: {
        transport: 'codex',
        payload: {
          threadId: 'native-thread',
          input: [
            { type: 'text', text: conversationDeliveryEnvelope(f.manifest, f.plan.inlineDeltaKeys) }
          ]
        }
      }
    },
    f.authority,
    f.signal
  )
  const reader = open()
  try {
    const first = reader.list().sources[0]!
    expect((await reader.read({ source: first.locator })).text).toBe(f.original)
    const foreign = Buffer.from(JSON.stringify(['wrong-root', 1, 0])).toString('base64url')
    await expect(reader.read({ source: foreign })).rejects.toMatchObject({ code: 'scope' })
  } finally {
    await reader.close()
  }
})
it('rechecks disclosure during cold verification and does not return bytes after close', async () => {
  f.bind()
  const reader = open(),
    source = reader.list().sources[0]!.locator
  const pending = reader.read({ source })
  const refused = expect(pending).rejects.toThrow()
  f.host.canRetrieve = () => false
  await refused
  f.host.canRetrieve = () => true
  const next = reader.read({ source })
  const closed = expect(next).rejects.toThrow()
  await reader.close()
  await closed
})
it('keeps active originals and queued continuation authorized after committing accepted coverage', async () => {
  f.bind()
  await f.journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  const { finalizeConversationDeliveryReceipt } = await import('./conversation-delivery-receipt')
  const receipt = await finalizeConversationDeliveryReceipt(
    f.fixture.host.db,
    f.plan.planId,
    f.authority,
    f.signal
  )
  if (!receipt) {
    throw new Error('missing real acceptance')
  }
  const beforeCoverage = readConversationCoverageRevision(f.fixture.host.db)
  runJournalTransaction(f.fixture.host.db, () =>
    recordConversationCoverage(
      f.fixture.host.db,
      f.manifest.manifestId,
      receipt.deliveryReceiptId,
      (db, id) => readConversationDeliveryReceipt(db, id, f.authority),
      f.authority.readPreparationEvidence
    )
  )
  expect(readConversationCoverageRevision(f.fixture.host.db)).toBeGreaterThan(beforeCoverage)
  const intent = f.fixture.records.conversations.intent(f.fixture.operationKey)!
  f.fixture.host.db
    .prepare(
      "UPDATE conversations SET record_json=json_set(record_json,'$.activeSegmentId',?,'$.pendingOperationKey',NULL,'$.activationFence',?)"
    )
    .run(intent.candidateSegmentId, intent.activationFence)
  f.fixture.host.db
    .prepare(
      "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','activated','$.deliveryReceiptId',?) WHERE operation_key=?"
    )
    .run(receipt.deliveryReceiptId, intent.operationKey)
  f.fixture.host.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.state','active') WHERE session_id=?"
    )
    .run(intent.targetSessionId)
  f.fixture.host.db
    .prepare(
      "UPDATE conversation_segments SET record_json=json_set(record_json,'$.lifecycle','activated') WHERE segment_id=?"
    )
    .run(intent.candidateSegmentId)
  f.host.readPreparationEvidence = () => null
  const reader = open()
  try {
    const source = reader.list().sources[0]!.locator
    expect((await reader.read({ source })).text).toBe(f.original)
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue without resending the old evidence.' }]
    }
    await f.sourceJournal.queuedMessages.insert({ messageId: 'continued-draft', body })
    const continuation = await prepareConversationTrigger(
      f.fixture.host.db,
      {
        transferId: 'continued-transfer',
        kind: 'queued-continuation',
        operationKey: intent.operationKey,
        deliveryPlanId: f.plan.planId,
        queueSessionId: 'session-a',
        messageId: 'continued-draft',
        targetSubmissionId: 'continued-submission'
      },
      { ...f.host, stateDirectory: f.fixture.host.stateDirectory },
      3,
      f.signal
    )
    expect(continuation.body).toEqual(body)
    expect(
      continuation.authority.verifyTriggerClaims(f.fixture.host.db, continuation.binding)
    ).toBe(true)
    f.fixture.host.db.prepare('DELETE FROM conversation_delivery_receipts').run()
    await expect(reader.read({ source })).rejects.toThrow()
  } finally {
    await reader.close()
  }
})
it('honors each tool call abort without permanently aborting a live acquisition', async () => {
  f.bind()
  const reader = open()
  try {
    const source = reader.list().sources[0]!.locator
    const controller = new AbortController()
    const pending = reader.read({ source }, controller.signal)
    const refused = expect(pending).rejects.toThrow('tool cancelled')
    controller.abort(new Error('tool cancelled'))
    await refused
    expect((await reader.read({ source }, new AbortController().signal)).text).toBe(f.original)
  } finally {
    await reader.close()
  }
})
it('rejects a forged cursor into the middle of a Unicode code point', async () => {
  f.bind()
  const reader = open()
  try {
    const source = reader.list().sources[0]!.locator
    const cursor = JSON.parse(Buffer.from(source, 'base64url').toString('utf8'))
    cursor[2] = Buffer.from(f.original).indexOf(Buffer.from('🙂')) + 1
    await expect(
      reader.read({ source, cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') })
    ).rejects.toMatchObject({ code: 'corrupt-source' })
  } finally {
    await reader.close()
  }
})
it('rejects an indexed member after its compilation proof disappears', async () => {
  f.fixture.close()
  f = await createConversationEvidenceFixture(true)
  const { observeConversationNativeInput } = await import('./conversation-delivery-input')
  await observeConversationNativeInput(
    f.fixture.host.db,
    {
      planId: f.plan.planId,
      submissionId: 'trigger',
      observation: {
        transport: 'codex',
        payload: {
          threadId: 'native-thread',
          input: [
            { type: 'text', text: conversationDeliveryEnvelope(f.manifest, f.plan.inlineDeltaKeys) }
          ]
        }
      }
    },
    f.authority,
    f.signal
  )
  const reader = open()
  try {
    const source = reader.list().sources[0]!.locator
    f.fixture.host.db
      .prepare('DELETE FROM conversation_manifest_compilations WHERE index_id=?')
      .run(f.manifest.evidenceIndex!.indexId)
    await expect(reader.read({ source })).rejects.toThrow()
  } finally {
    await reader.close()
  }
})
it('refuses a single metadata descriptor larger than the response budget', async () => {
  f.fixture.close()
  f = await createConversationEvidenceFixture(false, 1000)
  f.bind()
  const reader = open()
  try {
    expect(() => reader.list()).toThrowError(expect.objectContaining({ code: 'resource-limit' }))
  } finally {
    await reader.close()
  }
})
