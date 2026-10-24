import { expect, it } from 'vitest'
import {
  db,
  manifest,
  installArchiveProof,
  proofFor,
  receipt
} from './conversation-context-coverage.fixture'
import {
  conversationDeliveryEnvelope,
  inspectConversationDeliveryAssignments,
  type ConversationDeliveryHost
} from './conversation-delivery-plan'
import {
  saveConversationManifest,
  recordConversationCoverage
} from './conversation-context-coverage'
import { consentForConversationManifest } from './conversation-context-consent'
import { runJournalTransaction } from '../agent-session-journal/journal-database'

it('includes discoverable retrieval descriptors and revalidates access even with prior coverage', async () => {
  installArchiveProof()
  const m = manifest()
  const host: ConversationDeliveryHost = {
    getRecord: () => null,
    getJournal: () => null,
    readPreparationEvidence: proofFor(m),
    canRetrieve: () => true
  }
  runJournalTransaction(db, () =>
    saveConversationManifest(
      db,
      m,
      consentForConversationManifest(m, 'caller'),
      host.readPreparationEvidence
    )
  )
  const before = await inspectConversationDeliveryAssignments(
    db,
    m,
    host,
    new AbortController().signal
  )
  expect(before).toMatchObject({ acceptedPriorCount: 0, retrievalCount: 1, partCount: 1 })
  expect(conversationDeliveryEnvelope(m, before.inlineDeltaKeys)).toContain('archive')
  runJournalTransaction(db, () =>
    recordConversationCoverage(
      db,
      m.manifestId,
      'accepted',
      () => receipt(m),
      host.readPreparationEvidence
    )
  )
  const after = await inspectConversationDeliveryAssignments(
    db,
    m,
    host,
    new AbortController().signal
  )
  expect(after).toMatchObject({ acceptedPriorCount: 1, retrievalCount: 1, partCount: 1 })
  expect(conversationDeliveryEnvelope(m, after.inlineDeltaKeys)).toContain('archive')
  host.canRetrieve = () => false
  await expect(
    inspectConversationDeliveryAssignments(db, m, host, new AbortController().signal)
  ).rejects.toThrow('retrieval')
})
