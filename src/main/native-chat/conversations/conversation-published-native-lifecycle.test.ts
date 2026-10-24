import { appendConversationClearJournals } from './conversation-clear-journals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { createConversationOriginRowHook } from './conversation-origin-rows'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  assertConversationPendingNativePublished,
  readConversationFreshNativeProof
} from './conversation-pending-native-identity'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeTestJournalHostDatabase(root)
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['enrollment', 'clear'] as const)(
  'retains committed %s publication when a new switch begins, but requires its frozen proof',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-published-native-'))
    roots.push(root)
    const store = await openTestAgentSessionRecordStore(root)
    const database = openTestJournalHostDatabase(root)
    const db = database.db
    const sessionId = 'published-source'
    const targetId = 'published-target'
    const now = 1_800_000_000_000
    let serial = 0
    const operation = () => ({
      callerKey: 'test',
      operationId: `${now}-${String(++serial).padStart(32, '0')}`,
      fingerprint: `publication-${serial}`,
      now
    })
    const reserve = async (id: string) => {
      const prior = store.getRecord(id)
      const spawnToken = `spawn-${serial}`
      await store.reserveOwner({
        sessionId: id,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'folder',
          workspaceKind: 'folder'
        },
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: root },
        expectedFence: prior?.lease.runtimeFence ?? null,
        spawnToken,
        claimKeyId: 'key',
        handoffOperationId: null,
        probe: { outcome: 'reservation-unused' },
        operation: operation(),
        now
      })
      return spawnToken
    }
    const openJournal = (id: string) =>
      openAgentSessionJournal({
        database,
        identity: {
          sessionId: id,
          workspaceId: 'folder',
          hostId: 'local',
          agent: 'codex',
          providerHandle: null
        },
        requiredInTransaction: createConversationOriginRowHook(id),
        now: () => now
      })
    let spawnToken = await reserve(sessionId)
    await reserve(targetId)
    const journal = await openJournal(sessionId)
    const targetJournal = await openJournal(targetId)
    const acquire = async () => {
      const fence = store.getRecord(sessionId)!.lease.runtimeFence
      const generation = `child-${fence}`
      await store.commitProcessIdentity({
        sessionId,
        fence,
        process: { hostId: 'local', pid: 1234, processStartTimeMs: now, spawnToken },
        now
      })
      const origin = store.conversations.captureAcquisitionOrigin(sessionId)
      await store.proveOwner({
        sessionId,
        fence,
        acquisitionGeneration: generation,
        ...(origin ? { conversationOrigin: origin } : {}),
        now
      })
      await store.conversations.ensureSingleton(sessionId, { generation, fence })
      await store.publishProviderHandle({
        sessionId,
        fence,
        acquisitionGeneration: generation,
        now,
        link: {
          linkId: `native-${fence}`,
          origin: 'created',
          mintedAtFence: fence,
          observedAt: now,
          handle: codexProviderHandle(`thread-${fence}`)
        }
      })
      return { sessionId, fence, acquisitionGeneration: generation }
    }
    try {
      let publication = await acquire()
      let conversation = store.conversations.read(
        store.conversations.membership(sessionId)!.conversationId
      )!
      if (mode === 'clear') {
        const begun = await store.conversations.clear.begin(
          {
            conversationId: conversation.conversationId,
            expectedRevision: conversation.revision,
            expectedContextGeneration: conversation.contextGeneration,
            expectedActivationFence: conversation.activationFence
          },
          operation()
        )
        await store.evictProvenDeadOwner({
          sessionId,
          expectedFence: publication.fence,
          probe: { outcome: 'exit-observed' },
          now
        })
        const prepared = await store.conversations.clear.prepare({
          operationKey: begun.intent!.operationKey,
          expectedVersion: begun.intent!.version
        })
        await appendConversationClearJournals({
          journals: [journal],
          clear: store.conversations.clear,
          activeSessionId: sessionId,
          operationKey: prepared.operationKey,
          expectedVersion: prepared.version,
          now: now,
          isCurrent: (current) => current === journal
        })
        expect(() => assertConversationPendingNativePublished(db, publication)).toThrow()
        spawnToken = await reserve(sessionId)
        publication = await acquire()
        conversation = store.conversations.read(conversation.conversationId)!
        expect(conversation.contextGeneration).toBe(2)
      }
      const saved = db
        .prepare(
          'SELECT * FROM conversation_pending_native_identity WHERE session_id=? AND fence=?'
        )
        .get(sessionId, publication.fence)!
      const verify = () => assertConversationPendingNativePublished(db, publication)
      expect(verify).not.toThrow()
      const begun = await store.conversations.beginSwitch(
        {
          conversationId: conversation.conversationId,
          expectedRevision: conversation.revision,
          expectedContextGeneration: conversation.contextGeneration,
          expectedActivationFence: conversation.activationFence,
          target: store.getRecord(targetId)!,
          expectedNativeBindingGeneration: 1
        },
        operation()
      )
      expect(begun.intent?.phase).toBe('quiescing')
      expect(verify).not.toThrow()
      expect(
        readConversationFreshNativeProof(db, {
          sessionId,
          operationKey: String(saved.operation_key)
        })
      ).toBeNull()
      const faults =
        mode === 'enrollment'
          ? [
              'DELETE FROM conversation_origin_enrollments WHERE session_id=?',
              "DELETE FROM journal_epoch_pins WHERE session_id=? AND owner_id LIKE 'conversation-enrollment:%'"
            ]
          : [
              'DELETE FROM conversation_clear_rows WHERE session_id=?',
              "DELETE FROM journal_epoch_pins WHERE session_id=? AND owner_id LIKE 'conversation-clear:%'"
            ]
      for (const fault of faults) {
        db.exec('SAVEPOINT missing_native_authority')
        try {
          expect(db.prepare(fault).run(sessionId).changes).toBeGreaterThan(0)
          expect(verify, fault).toThrow('pending native publication unverified')
        } finally {
          db.exec('ROLLBACK TO missing_native_authority; RELEASE missing_native_authority')
        }
        expect(verify).not.toThrow()
      }
      expect(
        db
          .prepare(
            'SELECT * FROM conversation_pending_native_identity WHERE session_id=? AND fence=?'
          )
          .get(sessionId, publication.fence)
      ).toEqual(saved)
    } finally {
      await journal.close()
      await targetJournal.close()
    }
  }
)
