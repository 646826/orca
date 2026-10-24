import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { replayJournal } from '../agent-session-journal/journal-open'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { compileConversationContext } from './conversation-context-policy'
import {
  conversationContextAccountDigest,
  conversationContextSourceRevision,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'
import { conversationContextDigest } from './conversation-context-consent'
import { saveConversationManifest } from './conversation-context-coverage'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import {
  reserveConversationTrigger,
  readConversationTrigger
} from './conversation-trigger-reservation'
import { appendConversationTransfer } from '../agent-session-wire/structured-conversation-source-queue'
import {
  readQueuedMessageEvidence,
  readPinnedQueuedMessageEvidence,
  captureQueuedDraftOrigin
} from '../agent-session-journal/queued-message-origin'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'

it.each(['journal', 'failed-legacy-import'] as const)(
  'atomically withdraws an exact %s source and appends an ordinary target submission',
  async (sourceKind) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-trigger-writer-'))
    const location = {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder' as const
    }
    const accountHome = { variable: 'AGENT_HOME', path: '/account' }
    await seedTestAgentSessionRecordStore(root, {
      records: ['session-a', 'session-b'].map((sessionId) =>
        foundAgentSessionRecord(
          { sessionId, provider: 'codex', location, accountHome },
          { claimKeyId: sessionId, now: 1800000000000 }
        )
      )
    })
    const host = openTestJournalHostDatabase(root)
    const records = AgentSessionRecordStore.open({ journalDatabase: host, hostId: 'local' })
    let source = await openAgentSessionJournal({
      database: host,
      identity: {
        sessionId: 'session-a',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('session-a')
      }
    })
    const target = await openAgentSessionJournal({
      database: host,
      identity: {
        sessionId: 'session-b',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('session-b')
      }
    })
    try {
      const conversation = await records.conversations.ensureSingleton('session-a')
      const begun = await records.conversations.beginSwitch(
        {
          conversationId: conversation.conversationId,
          expectedRevision: 1,
          expectedContextGeneration: 1,
          expectedActivationFence: 1,
          target: { sessionId: 'session-b', provider: 'codex', location, accountHome },
          expectedNativeBindingGeneration: 1
        },
        {
          callerKey: 'caller',
          operationId: '1800000000000-000000000000000000000000000000aa',
          fingerprint: 'switch',
          now: 1800000000000
        }
      )
      if (!begun.intent?.candidateSegmentId) {
        throw new Error('candidate missing')
      }
      const compiled = compileConversationContext({
        conversationId: conversation.conversationId,
        contextGeneration: 1,
        sourceRevision: conversationContextSourceRevision(
          host.db,
          conversation.conversationId,
          'session-b'
        ),
        target: {
          sessionId: 'session-b',
          provider: 'codex',
          accountBindingDigest: conversationContextAccountDigest({
            provider: 'codex',
            location,
            accountHome
          }),
          nativeBindingGeneration: 1,
          capabilityFingerprint: 'test',
          model: 'test',
          retrieval: 'unsupported'
        },
        policy: 'fresh',
        originals: [],
        projection: [],
        mandatory: [],
        budget: null,
        countTokens: (t) => t.length,
        now: 1,
        signal: new AbortController().signal
      })
      if (compiled.kind !== 'compiled') {
        throw new Error(compiled.reason)
      }
      const m = compiled.manifest
      const proof: ConversationContextEvidenceReader = () => ({
        proofId: 'fresh-test',
        manifestDigest: m.digest,
        targetBindingDigest: m.targetBindingDigest,
        capabilityFingerprint: m.target.capabilityFingerprint,
        contextGeneration: 1,
        sourceRevision: m.sourceRevision,
        budgetDigest: conversationContextDigest(m.budget)
      })
      runJournalTransaction(host.db, () => saveConversationManifest(host.db, m, null, proof))
      await records.conversations.progress({
        operationKey: begun.intent.operationKey,
        expectedVersion: 1,
        phase: 'prepared',
        sourceBoundaries: begun.intent.sourceBoundaries,
        manifestId: m.manifestId,
        deliveryReceiptId: null
      })
      const body = {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'question' }]
      }
      const sourceOptions = { model: 'source-model', effort: 'high' }
      const targetOptions = { model: 'target-model', effort: 'low' }
      if (sourceKind === 'journal') {
        const original = await source.queuedMessages.insert({
          messageId: 'draft',
          body,
          options: sourceOptions
        })
        await source.queuedMessages.update({
          messageId: 'draft',
          expectedBodyFingerprint: original.fingerprint,
          text: 'edited question'
        })
      } else {
        const legacyBody = {
          ...body,
          blocks: [{ type: 'text' as const, text: 'legacy edited question' }]
        }
        runJournalTransaction(host.db, () => {
          host.db
            .prepare(`INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,options_json)
          VALUES('session-a','draft',1,?,?,10,'earlier','waiting',?)`)
            .run(
              JSON.stringify(legacyBody),
              agentSessionSendBodyFingerprint('session-a', legacyBody),
              JSON.stringify(sourceOptions)
            )
          captureQueuedDraftOrigin(host.db, {
            sessionId: 'session-a',
            messageId: 'draft',
            admittedAt: 10
          })
        })
        host.db.exec(
          `CREATE TEMP TRIGGER fail_source_import BEFORE DELETE ON queued_messages BEGIN SELECT RAISE(ABORT,'source import failed'); END`
        )
        await source.close()
        source = await openAgentSessionJournal({
          database: host,
          identity: {
            sessionId: 'session-a',
            workspaceId: 'folder',
            hostId: 'local',
            agent: 'codex',
            providerHandle: codexProviderHandle('session-a')
          }
        })
        expect(source.queuedMessages.get('draft')?.body).toEqual(legacyBody)
        expect(
          readQueuedMessageEvidence(host.db, {
            sourceSessionId: 'session-a',
            messageId: 'draft',
            fingerprint: agentSessionSendBodyFingerprint('session-a', legacyBody)
          })
        ).toBeNull()
      }
      const card = source.queuedMessages.get('draft')!
      const sourceBefore = source.cursor()
      const targetBefore = target.cursor()
      const binding: ConversationTriggerBinding = {
        transferId: 'trigger',
        kind: 'trigger',
        targetOptionsDigest: conversationContextDigest(targetOptions),
        operationKey: begun.intent.operationKey,
        conversationId: conversation.conversationId,
        contextGeneration: 1,
        candidateGeneration: 2,
        candidateSegmentId: begun.intent.candidateSegmentId,
        nativeBindingGeneration: 1,
        queueSessionId: 'session-a',
        messageId: 'draft',
        sourceFingerprint: card.fingerprint,
        expectedQueueState: 'waiting',
        targetSessionId: 'session-b',
        targetSubmissionId: 'fresh-submission',
        targetFingerprint: 'target-fingerprint',
        deliveryPlanId: 'test-plan',
        manifestId: m.manifestId,
        manifestDigest: m.digest,
        attachmentClaimsDigest: conversationContextDigest([])
      }
      const authority = {
        readPreparationEvidence: proof,
        verifyTriggerClaims: () => true,
        readSourceCard: (sessionId: string, messageId: string) =>
          sessionId === source.queuedMessages.sessionId
            ? source.queuedMessages.get(messageId)
            : null
      }
      runJournalTransaction(host.db, () => reserveConversationTrigger(host.db, binding, authority))
      const append = (fail = false) =>
        appendConversationTransfer({
          db: host.db,
          source,
          target,
          binding,
          authority,
          body: card.body,
          options: targetOptions,
          fence: 0,
          now: 2,
          isCurrent: (journal) => journal === source || journal === target,
          validate: () => {
            if (fail) {
              throw new Error('forced failure')
            }
          }
        })
      await expect(append(true)).rejects.toThrow('forced failure')
      expect(source.queuedMessages.get('draft')?.state).toBe('waiting')
      expect(source.cursor()).toEqual(sourceBefore)
      expect(target.cursor()).toEqual(targetBefore)
      expect(readConversationTrigger(host.db, binding.operationKey)?.state).toBe('reserved')
      if (sourceKind === 'failed-legacy-import') {
        await expect(append()).rejects.toThrow('source import failed')
        expect(source.cursor()).toEqual(sourceBefore)
        expect(target.cursor()).toEqual(targetBefore)
        expect(source.queuedMessages.get('draft')?.state).toBe('waiting')
        host.db.exec('DROP TRIGGER fail_source_import')
      }
      let observedBoth = false
      source.observeCommits(() => {
        observedBoth =
          source.queuedMessages.get('draft')?.state === 'withdrawn' &&
          target.submission(binding.targetSubmissionId)?.queuedMessageId === undefined &&
          target.submission(binding.targetSubmissionId) !== undefined
      })
      await append()
      expect(observedBoth).toBe(true)
      expect(source.queuedMessages.get('draft')).toMatchObject({
        state: 'withdrawn',
        consumedAs: null
      })
      expect(target.submission(binding.targetSubmissionId)?.queuedMessageId).toBeUndefined()
      expect(target.submission(binding.targetSubmissionId)?.options).toEqual(targetOptions)
      expect(
        readQueuedMessageEvidence(host.db, {
          sourceSessionId: source.queuedMessages.sessionId,
          messageId: 'draft',
          fingerprint: card.fingerprint
        })?.body
      ).toEqual(card.body)
      const replayedSource = replayJournal(host.db, 'session-a')!
      const replayedTarget = replayJournal(host.db, 'session-b')!
      expect(replayedSource.damage).toBeNull()
      expect(replayedTarget.damage).toBeNull()
      expect(replayedSource.state.queue.cards.get('draft')?.state).toBe('withdrawn')
      expect(
        replayedTarget.state.submissions.get(binding.targetSubmissionId)?.queuedMessageId
      ).toBeUndefined()
      expect(
        readPinnedQueuedMessageEvidence(host.db, {
          ownerId: 'conversation-transfer:trigger',
          sourceSessionId: 'session-a',
          messageId: 'draft',
          fingerprint: card.fingerprint
        })
      ).toMatchObject({
        body: card.body,
        options: sourceOptions,
        queueOrder: { position: card.position, queuedAt: card.queuedAt }
      })
      await append()
      expect(
        host.db
          .prepare(
            "SELECT COUNT(*) n FROM journal_rows WHERE session_id='session-b' AND json_extract(row_json,'$.kind')='submission'"
          )
          .get()?.n
      ).toBe(1)
    } finally {
      await target.close()
      await source.close()
      closeTestJournalHostDatabases()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
