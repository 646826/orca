import type Database from '../../sqlite/sync-database'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type {
  ConversationSwitchPlan,
  ConversationSwitchPorts
} from './conversation-switch-contracts'
import {
  readConversationDeliverySources,
  readParticipantSourceBoundaries
} from './conversation-read-model'
import { isConversationDeliveryEvidence } from '../../../shared/conversation-wire'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

const now = 1_800_000_000_000
const identity = (sessionId: string) => ({
  sessionId,
  provider: 'codex',
  location: {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder' as const
  },
  accountHome: { variable: 'AGENT_HOME', path: '/accounts/codex' }
})
export async function createConversationSwitchFixture(
  sourceText?: string,
  beforeEnrollment?: (
    db: Database.Database,
    host: ReturnType<typeof openTestJournalHostDatabase>
  ) => void | Promise<void>
) {
  const plans = new Map<string, ConversationSwitchPlan>()
  const directory = mkdtempSync(join(tmpdir(), 'orca-switch-coordinator-'))
  function append(sessionId: string, seq: number): void {
    insertJournalRow(openTestJournalHostDatabase(directory).db, sessionId, {
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: sessionId },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: `epoch-${sessionId}`,
      seq,
      fence: 1,
      ts: seq
    })
  }
  await seedTestAgentSessionRecordStore(directory, {
    records: ['session-a', 'session-b'].map((id) =>
      foundAgentSessionRecord(identity(id), { claimKeyId: id, now })
    )
  })
  const host = openTestJournalHostDatabase(directory)
  host.db.exec('CREATE TABLE test_delivery (id TEXT PRIMARY KEY, evidence TEXT NOT NULL)')
  const records = AgentSessionRecordStore.open({
    journalDatabase: host,
    hostId: 'local',
    conversationDeliveryCommit: () => undefined,
    conversationDeliveryEvidence: (db, id) => {
      const row = db.prepare('SELECT evidence FROM test_delivery WHERE id=?').get(id)
      if (typeof row?.evidence !== 'string') {
        return null
      }
      const value: unknown = JSON.parse(row.evidence)
      return isConversationDeliveryEvidence(value) ? value : null
    }
  })
  for (const id of ['session-a', 'session-b']) {
    append(id, 1)
    publishJournalSessionEpoch(host.db, { sessionId: id, workspaceId: 'folder' }, `epoch-${id}`)
  }
  if (sourceText !== undefined) {
    insertJournalRow(host.db, 'session-a', {
      kind: 'item',
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'epoch-session-a',
      seq: 2,
      fence: 1,
      ts: 2,
      itemId: 'source-message',
      revision: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: sourceText }] }
    })
  }
  await beforeEnrollment?.(host.db, host)
  const conversation = await records.conversations.ensureSingleton('session-a')
  const admission = await records.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: 1,
      target: identity('session-b'),
      expectedNativeBindingGeneration: 1
    },
    { callerKey: 'caller', operationId: `${now}-${'1'.repeat(32)}`, fingerprint: 'switch', now }
  )
  if (!admission.intent) {
    throw new Error('missing fixture intent')
  }
  const operationKey = admission.intent.operationKey
  const ports: ConversationSwitchPorts = {
    store: records.conversations,
    readSources: (intent) =>
      readConversationDeliverySources(host.db, intent.conversationId, intent.targetSessionId),
    quiesce: vi.fn<ConversationSwitchPorts['quiesce']>(async () => ({ kind: 'ready' as const })),
    prepare: vi.fn<ConversationSwitchPorts['prepare']>(async (intent) => {
      const plan: ConversationSwitchPlan = {
        manifestId: 'manifest',
        delivery: 'passive',
        sourceBoundaries: ports.readSources(intent)
      }
      plans.set(plan.manifestId, plan)
      return { kind: 'prepared' as const, plan }
    }),
    readPlan: (id) => plans.get(id) ?? null,
    reserveTrigger: vi.fn<ConversationSwitchPorts['reserveTrigger']>(async () => null),
    deliver: vi.fn<ConversationSwitchPorts['deliver']>(async (intent) => {
      const receiptId = 'receipt'
      host.db.prepare('INSERT OR REPLACE INTO test_delivery VALUES (?,?)').run(
        receiptId,
        JSON.stringify({
          deliveryReceiptId: receiptId,
          operationKey,
          manifestId: intent.manifestId,
          targetSessionId: intent.targetSessionId,
          contextGeneration: intent.contextGeneration,
          activationFence: intent.activationFence,
          nativeBindingGeneration: intent.nativeBindingGeneration,
          sourceBoundaries: intent.sourceBoundaries,
          candidateBaseline: intent.candidateBaseline,
          candidateBoundary: intent.candidateBoundary,
          candidateReadback: readParticipantSourceBoundaries(host.db, intent.targetSessionId)
        })
      )
      return { kind: 'accepted' as const, receiptId, candidateBoundary: intent.candidateBoundary }
    }),
    reconcile: vi.fn<ConversationSwitchPorts['reconcile']>(async () => ({
      kind: 'unknown' as const
    }))
  }
  return {
    host,
    records,
    operationKey,
    ports,
    plans,
    append,
    close: () => {
      closeTestJournalHostDatabases()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
