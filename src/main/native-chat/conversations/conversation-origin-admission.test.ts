import {
  recordConversationOriginCorrelation,
  resolveConversationOriginCorrelations
} from './conversation-origin-correlation'
import { bindConversationOrigin, readConversationOrigin } from './conversation-origin'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { bindConversationAcquisition } from './conversation-origin-capture'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
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
import { readConversationSourceSegmentId } from './conversation-source-attribution'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeTestJournalHostDatabase(root)
    rmSync(root, { recursive: true, force: true })
  }
})
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'orca-origin-admission-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const host = openTestJournalHostDatabase(root)
  const now = 1_800_000_000_000
  const { record } = await store.reserveOwner({
    sessionId: 'session-origin',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: root },
    expectedFence: null,
    spawnToken: 'spawn',
    claimKeyId: 'key',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${now}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now
  })
  const journal = await openAgentSessionJournal({
    database: host,
    identity: {
      sessionId: 'session-origin',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    }
  })
  await store.conversations.ensureSingleton('session-origin')
  await store.commitProcessIdentity({
    sessionId: 'session-origin',
    fence: record.lease.runtimeFence,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: now, spawnToken: 'spawn' },
    now
  })
  const origin = store.conversations.captureAcquisitionOrigin('session-origin')
  if (!origin) {
    throw new Error('missing frozen enrollment')
  }
  return { store, host, journal, origin, now, fence: record.lease.runtimeFence }
}
it('commits captured acquisition with real owner admission and reads frozen history without per-row backfill', async () => {
  const { store, host, journal, origin, now, fence } = await setup()
  await store.proveOwner({ sessionId: 'session-origin', fence, now, conversationOrigin: origin })
  expect(store.getRecord('session-origin')?.lease.claimStatus).toBe('live')
  expect(
    host.db
      .prepare(
        'SELECT origin_json FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
      )
      .get('session-origin', fence)
  ).toBeDefined()
  expect(
    readConversationSourceSegmentId(host.db, {
      sessionId: 'session-origin',
      epoch: journal.cursor().epoch,
      sequence: 1
    })
  ).toBe(origin.segmentId)
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_source_attribution').get()?.n).toBe(0)
  await journal.close()
})
it('rolls back the durable lease and published store when origin capture cannot commit', async () => {
  const { store, host, journal, origin, now, fence } = await setup()
  host.db.exec(
    "CREATE TRIGGER refuse_capture BEFORE INSERT ON conversation_origin_acquisitions BEGIN SELECT RAISE(ABORT,'capture failed'); END"
  )
  await expect(
    store.proveOwner({ sessionId: 'session-origin', fence, now, conversationOrigin: origin })
  ).rejects.toThrow('capture failed')
  expect(store.getRecord('session-origin')?.lease.claimStatus).toBe('reserved')
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_origin_acquisitions').get()?.n).toBe(
    0
  )
  await journal.close()
})
it('recovers captured scope for an activated participant with no initial enrollment', async () => {
  const { store, host, journal, origin, now, fence } = await setup()
  await store.proveOwner({
    sessionId: 'session-origin',
    fence,
    now,
    conversationOrigin: origin,
    link: {
      linkId: 'native-proof',
      handle: codexProviderHandle('native-thread'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: now
    }
  })
  host.db
    .prepare('DELETE FROM conversation_origin_enrollments WHERE session_id=?')
    .run('session-origin')
  expect(store.conversations.captureAcquisitionOrigin('session-origin')).toEqual(origin)
  const proof = host.db
    .prepare(
      'SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=? AND fence=?'
    )
    .get('session-origin', fence)?.native_identity
  host.db
    .prepare('UPDATE conversation_origin_acquisitions SET native_identity=NULL WHERE session_id=?')
    .run('session-origin')
  expect(() => store.conversations.captureAcquisitionOrigin('session-origin')).toThrow('unverified')
  host.db
    .prepare('UPDATE conversation_origin_acquisitions SET native_identity=? WHERE session_id=?')
    .run(String(proof), 'session-origin')
  host.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',2) WHERE session_id=?"
    )
    .run('session-origin')
  expect(() => store.conversations.captureAcquisitionOrigin('session-origin')).toThrow('generation')
  host.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',1) WHERE session_id=?"
    )
    .run('session-origin')
  host.db
    .prepare(
      "UPDATE agent_session_records SET record_json=json_set(record_json,'$.accountHome.path','/changed-account') WHERE session_id=?"
    )
    .run('session-origin')
  expect(() => store.conversations.captureAcquisitionOrigin('session-origin')).toThrow(
    'native identity changed'
  )
  expect(() =>
    host.transaction((db) =>
      bindConversationAcquisition(db, { sessionId: 'session-origin', fence, origin })
    )
  ).toThrow('cannot be rebound')
  await journal.close()
})
it('refuses stale member context before acquisition capture', async () => {
  const { store, host, journal } = await setup()
  host.db
    .prepare(
      "UPDATE conversation_participants SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE session_id=?"
    )
    .run('session-origin')
  expect(() => store.conversations.captureAcquisitionOrigin('session-origin')).toThrow('generation')
  await journal.close()
})

it.each(['exact', 'unknown-submission', 'stale-generation', 'unknown-fence'] as const)(
  'records causal turn provenance without accepting a send: %s',
  async (scenario) => {
    const { store, host, journal, origin, now, fence } = await setup()
    await store.proveOwner({
      sessionId: 'session-origin',
      fence,
      now,
      conversationOrigin: origin,
      link: {
        linkId: 'causal-proof',
        handle: codexProviderHandle('native-thread'),
        origin: 'created',
        mintedAtFence: fence,
        observedAt: now
      }
    })
    const turnIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-origin',
      recordId: 'turn-lifecycle:turn-1'
    }
    host.transaction((db) => {
      if (scenario !== 'unknown-submission') {
        bindConversationOrigin(db, {
          sessionId: 'session-origin',
          key: { kind: 'submission', id: 'send' },
          origin
        })
      }
      if (scenario === 'stale-generation') {
        db.prepare(
          "UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',2) WHERE session_id=?"
        ).run('session-origin')
      }
      recordConversationOriginCorrelation(db, {
        state: 'origin-correlated',
        sessionId: 'session-origin',
        clientMessageId: 'send',
        fence: scenario === 'unknown-fence' ? fence + 1 : fence,
        turnIdentity
      })
    })
    expect(
      readConversationOrigin(
        host.db,
        'session-origin',
        { kind: 'turn', id: agentJournalItemKey(turnIdentity) },
        1
      )
    ).toEqual(scenario === 'exact' ? origin : null)
    expect(
      host.db.prepare('SELECT resolved FROM conversation_origin_correlations').get()?.resolved
    ).toBe(scenario === 'exact' ? 1 : 0)
    if (scenario === 'unknown-submission') {
      host.transaction((db) => {
        bindConversationOrigin(db, {
          sessionId: 'session-origin',
          key: { kind: 'submission', id: 'send' },
          origin
        })
        expect(resolveConversationOriginCorrelations(db, 'session-origin')).toBe(1)
        expect(resolveConversationOriginCorrelations(db, 'session-origin')).toBe(0)
      })
      expect(
        readConversationOrigin(
          host.db,
          'session-origin',
          { kind: 'turn', id: agentJournalItemKey(turnIdentity) },
          1
        )
      ).toEqual(origin)
    }
    expect(journal.receiptFor('send')).toBeNull()
    await journal.close()
  }
)
