import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import { createConversationEvidenceFixture } from './conversation-evidence-reader.test-fixture'
import {
  finalizeConversationDeliveryReceipt,
  readConversationDeliveryReceipt
} from './conversation-delivery-receipt'
import { recordConversationCoverage } from './conversation-context-coverage'
import { readConversationCoverageRevision } from './conversation-context-authority-revision'
import { hasConversationRepresentationCoverage } from './conversation-context-index-delta'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-evidence'
import { conversationDeliveryEnvelope } from './conversation-delivery-plan'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { canonicalUserConstraint } from './conversation-context-constraints'

const fixtures: Awaited<ReturnType<typeof createConversationEvidenceFixture>>[] = []
afterEach(() => fixtures.splice(0).forEach((f) => f.fixture.close()))

async function acceptedSource(queued = false) {
  const f = await createConversationEvidenceFixture(
    false,
    0,
    undefined,
    queued
      ? async (_db, database) => {
          const journal = new AgentSessionJournal({
            database,
            identity: {
              sessionId: 'session-a',
              workspaceId: 'folder',
              hostId: 'local',
              agent: 'codex',
              providerHandle: {
                transport: 'codex-app-server',
                agent: 'codex',
                nativeId: 'session-a'
              }
            }
          })
          await journal.open()
          try {
            const body: AgentJournalMessageItem = {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Never upload files. mandatory final constraint🙂' }]
            }
            const fingerprint = agentSessionSendBodyFingerprint('session-a', body)
            await journal.queuedMessages.insert({
              messageId: 'queued-source',
              body
            })
            await journal.appendSubmission(
              {
                clientMessageId: 'queued-submission',
                body,
                payloadFingerprint: fingerprint,
                origin: 'host',
                fence: 1,
                handoverRecorded: true
              },
              {
                messageId: 'queued-source',
                expect: 'waiting',
                yieldsToPause: true
              }
            )
          } finally {
            await journal.close()
          }
        }
      : undefined
  )
  fixtures.push(f)
  f.bind()
  await f.journal.resolveDispatch({
    clientMessageId: 'trigger',
    fence: 1,
    state: 'accepted',
    originCorrelation: 'exact',
    providerIdentity: { provider: 'codex', threadId: 'native-thread', turnId: 'turn', ordinal: 0 }
  })
  const db = f.fixture.host.db
  const receipt = await finalizeConversationDeliveryReceipt(
    db,
    f.plan.planId,
    f.authority,
    f.signal
  )
  if (!receipt) {
    throw new Error('missing real acceptance')
  }
  runJournalTransaction(db, () =>
    recordConversationCoverage(
      db,
      f.manifest.manifestId,
      receipt.deliveryReceiptId,
      (database, id) => readConversationDeliveryReceipt(database, id, f.authority),
      f.authority.readPreparationEvidence
    )
  )
  const part = f.manifest.projection[0]!
  const coverage = {
    revision: readConversationCoverageRevision(db),
    nativeIdentityDigest: f.plan.nativeIdentityDigest
  }
  expect(hasConversationRepresentationCoverage(db, { ...f.manifest, ...coverage }, part)).toBe(true)
  return { ...f, db, part, coverage }
}

it.each([false, true])(
  're-inlines accepted user content and refuses actual outgoing overflow (queued source: %s)',
  async (queued) => {
    const f = await acceptedSource(queued)
    if (queued) {
      expect(JSON.parse(f.original)).toMatchObject({
        kind: 'submission',
        origin: 'host',
        queuedMessageId: 'queued-source'
      })
      expect(canonicalUserConstraint(f.original, 'Never upload files')).toBe(false)
    }
    const compile = (maxInlineBytes: number, text = f.original) =>
      compileConversationContextPages({
        db: f.db,
        conversationId: f.manifest.conversationId,
        contextGeneration: f.manifest.contextGeneration,
        sourceRevision: f.manifest.sourceRevision,
        target: f.manifest.target,
        policy: 'budgeted',
        mandatory: [],
        budget: null,
        countTokens: null,
        now: 1,
        signal: f.signal,
        maxInlineBytes,
        coverage: f.coverage,
        expected: {
          sourceCount: 1,
          orderedVersionDigest: createHash('sha256')
            .update(`${conversationEvidenceKey(f.part.version)}\n`)
            .digest('hex')
        },
        rows: (async function* () {
          yield {
            original: { version: f.part.version, text, kind: 'historical-data' as const, gaps: [] },
            representation: f.part
          }
        })()
      })
    const result = await compile(65536)
    expect(result.kind).toBe('compiled')
    if (result.kind !== 'compiled') {
      throw new Error(result.reason)
    }
    expect(result.manifest.projection).toEqual([f.part])
    const envelope = conversationDeliveryEnvelope(result.manifest)
    expect(envelope).toContain('mandatory final constraint🙂')
    expect(result.manifest.inputTokens).toBeNull()
    expect(await compile(Buffer.byteLength(envelope) - 1)).toEqual({
      kind: 'refused',
      reason: 'resource-limit'
    })
    expect(await compile(65536, `${f.original} changed`)).toEqual({
      kind: 'refused',
      reason: 'invalid-provenance'
    })
  }
)
