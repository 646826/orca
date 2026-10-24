import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
export const now = 1_800_000_000_000
export const operation = {
  callerKey: 'caller',
  operationId: `${now}-${'c'.repeat(32)}`,
  fingerprint: 'clear',
  now
}
export async function createClearStoreFixture(root: string) {
  const identity = {
    sessionId: 'session-a',
    provider: 'codex',
    location: {
      executionHostId: 'local' as const,
      workspaceId: 'folder',
      workspaceKind: 'folder' as const,
      wslDistro: null
    },
    accountHome: { variable: 'CODEX_HOME', path: '/accounts/a' }
  }
  await seedTestAgentSessionRecordStore(root, {
    records: ['session-a', 'session-b'].map((sessionId) => ({
      ...foundAgentSessionRecord({ ...identity, sessionId }, { claimKeyId: sessionId, now }),
      providerHandleChain: [
        {
          linkId: sessionId,
          origin: 'created' as const,
          mintedAtFence: 1,
          observedAt: now,
          handle: codexProviderHandle(sessionId)
        }
      ]
    }))
  })
  const host = openTestJournalHostDatabase(root)
  const records = AgentSessionRecordStore.open({ journalDatabase: host, hostId: 'local' })
  insertJournalRow(host.db, 'session-a', {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'session-a' },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'e',
    seq: 1,
    fence: 1,
    ts: now
  })
  publishJournalSessionEpoch(host.db, { sessionId: 'session-a', workspaceId: 'folder' }, 'e')
  insertJournalRow(host.db, 'session-b', {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'session-b' },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'b',
    seq: 1,
    fence: 1,
    ts: now
  })
  publishJournalSessionEpoch(host.db, { sessionId: 'session-b', workspaceId: 'folder' }, 'b')
  let conversation = await records.conversations.ensureSingleton('session-a')
  const switching = await records.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: 1,
      target: records.getRecord('session-b')!,
      expectedNativeBindingGeneration: 1
    },
    { ...operation, operationId: `${now}-${'e'.repeat(32)}`, fingerprint: 'enroll' }
  )
  conversation = records.conversations.read(conversation.conversationId)!
  await records.conversations.cancel({
    operationKey: switching.intent!.operationKey,
    expectedVersion: switching.intent!.version,
    expectedRevision: conversation.revision,
    expectedContextGeneration: 1,
    expectedActivationFence: 1
  })
  conversation = records.conversations.read(conversation.conversationId)!

  return { host, records, conversation }
}
