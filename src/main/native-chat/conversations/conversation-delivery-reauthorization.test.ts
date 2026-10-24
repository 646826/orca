import { contextSourceText } from './conversation-context-source-row.fixture'
import { createHash } from 'node:crypto'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { expect, it } from 'vitest'
import {
  db,
  manifest,
  installArchiveProof,
  installDeliveryIntent,
  proofFor
} from './conversation-context-coverage.fixture'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import {
  authorizeConversationManifestIndex,
  assertConversationManifestIndexAuthorization
} from './conversation-context-index-authority'
import { saveConversationManifest } from './conversation-context-coverage'
import { consentForConversationManifest } from './conversation-context-consent'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import {
  inspectConversationDeliveryAssignments,
  prepareConversationDeliveryPlan,
  type ConversationDeliveryHost
} from './conversation-delivery-plan'
import { refreshVerifiedConversationManifestIndex } from './conversation-delivery-reauthorization'
async function indexedManifest() {
  const initial = manifest()
  installArchiveProof()
  const parts = initial.projection
  const result = await compileConversationContextPages({
    db,
    expected: {
      sourceCount: parts.length,
      orderedVersionDigest: createHash('sha256')
        .update(parts.map((part) => `${conversationEvidenceKey(part.version)}\n`).join(''))
        .digest('hex')
    },
    rows: (async function* () {
      for (const part of parts) {
        yield {
          original: {
            version: part.version,
            text: contextSourceText,
            kind: 'historical-data' as const,
            gaps: []
          },
          representation: part
        }
      }
    })(),
    maxInlineBytes: 1024 * 1024,
    conversationId: initial.conversationId,
    contextGeneration: 1,
    sourceRevision: initial.sourceRevision,
    target: initial.target,
    policy: 'budgeted',
    mandatory: [],
    budget: initial.budget,
    countTokens: () => 100,
    now: 10,
    signal: new AbortController().signal
  })
  if (result.kind !== 'compiled') {
    throw new Error(result.reason)
  }
  const m = result.manifest
  installDeliveryIntent(m)
  const read = () => ({
    ...proofFor(m)(),
    evidenceIndex: m.evidenceIndex,
    sourceEnumeration: {
      sourceCount: parts.length,
      orderedVersionDigest: createHash('sha256')
        .update(parts.map((part) => `${conversationEvidenceKey(part.version)}\n`).join(''))
        .digest('hex')
    }
  })
  await authorizeConversationManifestIndex(db, m, read, new AbortController().signal)
  return { m, read }
}

it('refreshes a nonempty sealed plan after own authority writes outside the writer queue', async () => {
  const { m, read } = await indexedManifest()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), read)
  )
  db.prepare('UPDATE conversation_source_attribution SET segment_id=segment_id').run()
  expect(() => assertConversationManifestIndexAuthorization(db, m)).toThrow()
  const record = foundAgentSessionRecord(
    {
      sessionId: 'session-b',
      provider: 'codex',
      accountHome: { variable: 'AGENT_HOME', path: '/account' },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      }
    },
    { claimKeyId: 'test', now: 1 }
  )
  const native = {
    ...record,
    lease: {
      ...record.lease,
      claimStatus: 'live' as const,
      unreconciled: false,
      provenHandleLinkId: 'link'
    },
    providerHandleChain: [
      {
        linkId: 'link',
        handle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'thread' },
        origin: 'created' as const,
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  }
  const host: ConversationDeliveryHost = {
    getRecord: () => native,
    getJournal: () => null,
    readPreparationEvidence: read,
    canRetrieve: () => true
  }
  await refreshVerifiedConversationManifestIndex(
    db,
    m.manifestId,
    read,
    new AbortController().signal
  )
  expect(
    await inspectConversationDeliveryAssignments(db, m, host, new AbortController().signal)
  ).toMatchObject({ partCount: 1, retrievalCount: 1 })
  db.prepare(
    "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.phase','prepared','$.candidateSegmentId','candidate')"
  ).run()
  const intentRow = db
    .prepare(
      "SELECT operation_key FROM conversation_switch_intents WHERE json_extract(record_json,'$.manifestId')=?"
    )
    .get(m.manifestId)
  if (typeof intentRow?.operation_key !== 'string') {
    throw new Error('missing intent')
  }
  db.prepare(
    "UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey',?)"
  ).run(intentRow.operation_key)
  const plan = await prepareConversationDeliveryPlan(
    db,
    { operationKey: intentRow.operation_key, manifestId: m.manifestId, expectedIntentVersion: 1 },
    host,
    new AbortController().signal
  )
  expect(plan).toMatchObject({ partCount: 1, retrievalCount: 1, acceptedPriorCount: 0 })
  db.prepare('UPDATE conversation_source_attribution SET segment_id=segment_id').run()
  await expect(
    refreshVerifiedConversationManifestIndex(
      db,
      m.manifestId,
      () => null,
      new AbortController().signal
    )
  ).rejects.toThrow('unverified')
  db.exec('BEGIN')
  try {
    await expect(
      refreshVerifiedConversationManifestIndex(db, m.manifestId, read, new AbortController().signal)
    ).rejects.toThrow('writer')
  } finally {
    db.exec('ROLLBACK')
  }
})
