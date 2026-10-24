import { auditPreparationBenchmarkSources } from './conversation-context-benchmark-preparation-audit'
import { createHash } from 'node:crypto'
import { seedPreparationBenchmarkRows } from './conversation-context-benchmark-preparation-seed'
import { JournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../../src/main/native-chat/agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../src/shared/agent-session-journal-types'
import { AgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store'
import { AgentSessionAttachmentStore } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-references'
import { createConversationPreparationService } from '../../src/main/native-chat/conversations/conversation-preparation-service'
import type { ConversationPreparationTarget } from '../../src/main/native-chat/conversations/conversation-preparation-authority'
import { conversationContextAccountDigest } from '../../src/main/native-chat/conversations/conversation-context-authority'
import {
  conversationContextDigest,
  consentForConversationManifest
} from '../../src/main/native-chat/conversations/conversation-context-consent'
import { approveConversationPreparationRequest } from '../../src/main/native-chat/conversations/conversation-preparation-request'
import { approveConversationPreparation } from '../../src/main/native-chat/conversations/conversation-preparation-consent'
import { conversationEvidenceKey } from '../../src/main/native-chat/conversations/conversation-context-evidence'

const now = 1_800_000_000_000
export async function createPreparationBenchmarkFixture(input: {
  stateDirectory: string
  eventCount: number
  policy: 'full' | 'budgeted'
  projection?: 'exact' | 'tools'
  requiredTextBytes?: number
  toolRowBytes?: number
}) {
  const host = JournalHostDatabase.open(input.stateDirectory)
  try {
    const records = AgentSessionRecordStore.open({ journalDatabase: host, hostId: 'local' })
    const identity = (sessionId: string) => ({
      sessionId,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/synthetic/benchmark-account' },
      location: {
        executionHostId: 'local' as const,
        workspaceId: 'synthetic-folder',
        workspaceKind: 'folder' as const,
        wslDistro: null
      }
    })
    for (const [index, id] of ['synthetic-session', 'synthetic-target'].entries()) {
      await records.founding.commit({
        ...identity(id),
        expectedFence: null,
        spawnToken: 'unused',
        claimKeyId: id,
        handoffOperationId: null,
        probe: { outcome: 'pid-absent' },
        now,
        operation: {
          callerKey: 'benchmark',
          operationId: `${now}-${String(index + 1).repeat(32)}`,
          fingerprint: id
        }
      })
    }
    const sourceCount =
      input.eventCount + 1 + (input.requiredTextBytes ? 1 : 0) + (input.toolRowBytes ? 1 : 0)
    const expected = createHash('sha256')
    let sourceBytes = 0
    host.transaction((db) => {
      seedPreparationBenchmarkRows(db, input, sourceCount)
      insertJournalRow(db, 'synthetic-target', {
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'codex', threadId: 'synthetic-target' },
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'target',
        seq: 1,
        fence: 1,
        ts: now
      })
      publishJournalSessionEpoch(
        db,
        { sessionId: 'synthetic-session', workspaceId: 'synthetic-folder' },
        'synthetic'
      )
      publishJournalSessionEpoch(
        db,
        { sessionId: 'synthetic-target', workspaceId: 'synthetic-folder' },
        'target'
      )
    })
    for (const row of host.db
      .prepare('SELECT seq,row_json FROM journal_rows WHERE session_id=? ORDER BY seq')
      .iterate('synthetic-session')) {
      if (typeof row.row_json !== 'string' || typeof row.seq !== 'number') {
        throw new Error('Invalid fixture row')
      }
      const version = {
        source: { sessionId: 'synthetic-session', epoch: 'synthetic', sequence: row.seq },
        sha256: createHash('sha256').update(row.row_json).digest('hex')
      }
      expected.update(conversationEvidenceKey(version)).update('\n')
      sourceBytes += Buffer.byteLength(row.row_json)
    }
    const expectedRoot = expected.digest('hex')
    const conversation = await records.conversations.ensureSingleton('synthetic-session')
    const begun = await records.conversations.beginSwitch(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: 1,
        expectedActivationFence: 1,
        expectedNativeBindingGeneration: 1,
        target: identity('synthetic-target')
      },
      {
        callerKey: 'benchmark',
        operationId: `${now}-${'3'.repeat(32)}`,
        fingerprint: 'switch',
        now
      }
    )
    const intent = begun.intent
    const targetRecord = records.getRecord('synthetic-target')
    if (!intent || !targetRecord) {
      throw new Error('Benchmark founding failed')
    }
    const target = {
      sessionId: intent.targetSessionId,
      provider: 'codex',
      accountBindingDigest: conversationContextAccountDigest(targetRecord),
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'synthetic-protocol-contract-not-native-verified',
      model: 'synthetic-byte-estimator',
      retrieval: input.projection === 'tools' ? ('verified' as const) : ('unsupported' as const)
    }
    const observed: ConversationPreparationTarget = {
      target,
      nativeIdentityDigest: 'synthetic-native-observation',
      runtimeFence: 1,
      optionsDigest: conversationContextDigest(null),
      freshNative: false,
      budget:
        input.policy === 'full'
          ? {
              capacity: 100_000_000,
              occupied: 0,
              reserved: 10000,
              confidence: 'upper-bound',
              targetFingerprint: target.capabilityFingerprint,
              nativeBindingGeneration: 1,
              model: target.model,
              accountBindingDigest: target.accountBindingDigest,
              observedAt: now,
              validUntil: now + 1000
            }
          : null
    }
    const attachments = new AgentSessionAttachmentStore(
      agentSessionAttachmentStoreRoot(input.stateDirectory),
      { hasSession: (id) => records.getRecord(id) !== null }
    )
    const service = createConversationPreparationService({
      db: host.db,
      stateDirectory: input.stateDirectory,
      store: () => attachments,
      readTarget: () => observed,
      now: () => now + 1,
      // Synthetic byte-unit capacity only; this does not verify a provider tokenizer.
      fullEstimator: () => ({
        countTokens: (text) => Buffer.byteLength(text),
        confidence: 'upper-bound'
      })
    })
    approveConversationPreparationRequest(
      host.db,
      {
        operationKey: intent.operationKey,
        expectedVersion: intent.version,
        expectedContextGeneration: 1,
        targetSessionId: intent.targetSessionId,
        targetBindingDigest: conversationContextDigest(target),
        capabilityFingerprint: target.capabilityFingerprint,
        policy: input.policy,
        disclosure: 'available-canonical'
      },
      'benchmark'
    )
    return {
      host,
      records,
      intent,
      attachments,
      sourceBytes,
      expectedRoot,
      sourceCount,
      close: () => host.close(),
      async run(signal: AbortSignal) {
        let outcome = await service.preparation.prepare(intent, null, signal, null)
        if (outcome.kind === 'blocked') {
          return {
            status: outcome.reasons.every(
              (reason) => reason === 'resource-limit' || reason === 'overflow'
            )
              ? 'capacity-refused'
              : 'failed',
            reasons: outcome.reasons,
            integrity: false,
            requestedSourceCount: sourceCount,
            sourceBytes,
            projection: input.projection ?? 'exact',
            nativeAcceptance: 'not-run'
          }
        }
        const saved = host.db
          .prepare(
            'SELECT manifest_id FROM conversation_preparation_previews WHERE operation_key=? ORDER BY rowid DESC LIMIT 1'
          )
          .get(intent.operationKey)
        if (typeof saved?.manifest_id !== 'string') {
          throw new Error('Missing production preview')
        }
        const preview = service.authority.readPreview(saved.manifest_id)
        if (!preview) {
          throw new Error('Unverified production preview')
        }
        if (outcome.kind === 'waiting-consent') {
          const { approvedBy: _, ...digests } = consentForConversationManifest(
            preview.manifest,
            'benchmark'
          )
          approveConversationPreparation(
            host.db,
            {
              ...digests,
              operationKey: intent.operationKey,
              expectedVersion: intent.version,
              expectedContextGeneration: 1
            },
            'benchmark',
            service.authority
          )
          outcome = await service.preparation.prepare(
            intent,
            preview.manifest.manifestId,
            signal,
            null
          )
        }
        if (outcome.kind !== 'prepared' || !service.preparation.readPlan(outcome.plan.manifestId)) {
          throw new Error('Preparation not durably authorized')
        }
        const { integrity, count, summarizedSourceCount, exportedSourceCount } =
          await auditPreparationBenchmarkSources(
            host.db,
            preview.manifest,
            sourceCount,
            expectedRoot,
            preview.sources.enumeration.orderedVersionDigest,
            signal,
            input.projection === 'tools'
              ? {
                  projection: 'tools',
                  exportScope: {
                    db: host.db,
                    stateDirectory: input.stateDirectory,
                    store: attachments,
                    conversationId: intent.conversationId,
                    contextGeneration: intent.contextGeneration,
                    signal
                  }
                }
              : undefined
          )
        return {
          status: 'completed',
          integrity,
          sourceCount: count,
          manifestId: outcome.plan.manifestId,
          projection: input.projection ?? 'exact',
          summarizedSourceCount,
          exportedSourceCount,
          sourceBytes,
          sourceRoot: expectedRoot,
          consent: input.policy === 'budgeted' ? 'approved-exact-manifest' : 'not-required',
          nativeAcceptance: 'not-run',
          policy: input.policy,
          distribution:
            '10-event cycles: submission,pending,provider echo,accepted,assistant,tool start/result,assistant revision,user,assistant'
        }
      }
    }
  } catch (error) {
    host.close()
    throw error
  }
}
