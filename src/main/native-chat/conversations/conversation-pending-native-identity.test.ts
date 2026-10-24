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
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readConversationFreshNativeProof } from './conversation-pending-native-identity'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeTestJournalHostDatabase(root)
    rmSync(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-pending-native-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
  const database = openTestJournalHostDatabase(root)
  const now = 1_800_000_000_000
  const location = {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder' as const
  }
  for (const [index, sessionId] of ['source-pending', 'target-pending'].entries()) {
    await store.reserveOwner({
      sessionId,
      location,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: root },
      expectedFence: null,
      spawnToken: sessionId,
      claimKeyId: 'key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: `${now}-${String(index + 1).padStart(32, '0')}`,
        fingerprint: sessionId
      },
      now
    })
    await openAgentSessionJournal({
      database,
      identity: {
        sessionId,
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'codex',
        providerHandle: null
      }
    })
  }
  const conversation = await store.conversations.ensureSingleton('source-pending')
  const begun = await store.conversations.beginSwitch(
    {
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
      expectedContextGeneration: 1,
      expectedActivationFence: conversation.activationFence,
      target: store.getRecord('target-pending')!,
      expectedNativeBindingGeneration: 1
    },
    {
      callerKey: 'test',
      operationId: `${now}-${'3'.padStart(32, '0')}`,
      fingerprint: 'switch',
      now
    }
  )
  const intent = begun.intent!
  const fence = store.getRecord('target-pending')!.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: 'target-pending',
    fence,
    process: { hostId: 'local', pid: 1234, processStartTimeMs: now, spawnToken: 'target-pending' },
    now
  })
  const origin = store.conversations.captureAcquisitionOrigin('target-pending')!
  const link = {
    linkId: 'first-created',
    handle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f61'),
    origin: 'created' as const,
    mintedAtFence: fence,
    observedAt: now
  }
  return { store, db: database.db, root, now, intent, fence, origin, link }
}
it('publishes only a same-acquisition first-created native identity and replays identically', async () => {
  const f = await fixture()
  await f.store.proveOwner({
    sessionId: 'target-pending',
    fence: f.fence,
    now: f.now,
    conversationOrigin: f.origin,
    acquisitionGeneration: 'child-1'
  })
  expect(
    readConversationFreshNativeProof(f.db, {
      sessionId: 'target-pending',
      operationKey: f.intent.operationKey
    })
  ).toBeNull()
  const request = {
    sessionId: 'target-pending',
    fence: f.fence,
    acquisitionGeneration: 'child-1',
    link: f.link,
    now: f.now
  }
  await f.store.publishProviderHandle(request)
  expect(
    readConversationFreshNativeProof(f.db, {
      sessionId: 'target-pending',
      operationKey: f.intent.operationKey
    })
  ).not.toBeNull()
  await f.store.publishProviderHandle(request)
  expect(f.store.getRecord('target-pending')!.providerHandleChain).toHaveLength(1)
})
it('proves an initial acquired.link in the owner transaction too', async () => {
  const f = await fixture()
  await f.store.proveOwner({
    sessionId: 'target-pending',
    fence: f.fence,
    now: f.now,
    conversationOrigin: f.origin,
    acquisitionGeneration: 'child-1',
    link: f.link
  })
  expect(
    readConversationFreshNativeProof(f.db, {
      sessionId: 'target-pending',
      operationKey: f.intent.operationKey
    })
  ).not.toBeNull()
})
it.each([
  'resumed',
  'foreign-acquisition',
  'changed-account',
  'cancelled',
  'unknown-effect'
] as const)('refuses pending publication: %s', async (mode) => {
  const f = await fixture()
  await f.store.proveOwner({
    sessionId: 'target-pending',
    fence: f.fence,
    now: f.now,
    conversationOrigin: f.origin,
    acquisitionGeneration: 'child-1'
  })
  if (mode === 'changed-account') {
    await f.store.transitionHandoff('target-pending', (record) => ({
      ...record,
      accountHome: { variable: 'CODEX_HOME', path: '/changed' }
    }))
  }
  if (mode === 'cancelled') {
    const c = f.store.conversations.read(f.intent.conversationId)!
    await f.store.conversations.cancel({
      operationKey: f.intent.operationKey,
      expectedVersion: f.intent.version,
      expectedContextGeneration: 1,
      expectedRevision: c.revision,
      expectedActivationFence: c.activationFence
    })
  }
  if (mode === 'unknown-effect') {
    f.db.prepare('UPDATE conversation_pending_native_identity SET effect_seen=1').run()
  }
  await expect(
    f.store.publishProviderHandle({
      sessionId: 'target-pending',
      fence: f.fence,
      acquisitionGeneration: mode === 'foreign-acquisition' ? 'other' : 'child-1',
      link: { ...f.link, origin: mode === 'resumed' ? 'resumed' : 'created' },
      now: f.now
    })
  ).rejects.toThrow()
  expect(f.store.getRecord('target-pending')!.providerHandleChain).toHaveLength(0)
})

it('rolls back first handle with failed proof commit and survives reopening before and after publication', async () => {
  const f = await fixture()
  await f.store.proveOwner({
    sessionId: 'target-pending',
    fence: f.fence,
    now: f.now,
    conversationOrigin: f.origin,
    acquisitionGeneration: 'child-1'
  })
  const request = {
    sessionId: 'target-pending',
    fence: f.fence,
    acquisitionGeneration: 'child-1',
    link: f.link,
    now: f.now
  }
  f.db.exec(
    "CREATE TRIGGER fail_pending_publish BEFORE UPDATE ON conversation_pending_native_identity WHEN NEW.native_identity IS NOT NULL BEGIN SELECT RAISE(ABORT,'simulated durable failure'); END"
  )
  await expect(f.store.publishProviderHandle(request)).rejects.toThrow('simulated durable failure')
  expect(f.store.getRecord('target-pending')!.providerHandleChain).toHaveLength(0)
  expect(
    f.db
      .prepare('SELECT native_identity FROM conversation_origin_acquisitions WHERE session_id=?')
      .get('target-pending')?.native_identity
  ).toBeNull()
  f.db.exec('DROP TRIGGER fail_pending_publish')
  const reopened = await openTestAgentSessionRecordStore(f.root)
  expect(reopened.getRecord('target-pending')!.providerHandleChain).toHaveLength(0)
  await reopened.publishProviderHandle(request)
  const after = await openTestAgentSessionRecordStore(f.root)
  expect(after.getRecord('target-pending')!.providerHandleChain).toHaveLength(1)
  expect(
    readConversationFreshNativeProof(f.db, {
      sessionId: 'target-pending',
      operationKey: f.intent.operationKey
    })
  ).not.toBeNull()
})
it('refuses acquired resumed handle and rolls back the owner proof', async () => {
  const f = await fixture()
  await expect(
    f.store.proveOwner({
      sessionId: 'target-pending',
      fence: f.fence,
      now: f.now,
      conversationOrigin: f.origin,
      acquisitionGeneration: 'child-1',
      link: { ...f.link, origin: 'resumed' }
    })
  ).rejects.toThrow()
  expect(f.store.getRecord('target-pending')!.lease.claimStatus).toBe('reserved')
  expect(f.store.getRecord('target-pending')!.providerHandleChain).toHaveLength(0)
})
it('refuses stale fence and a no-link open after unverified generic handle persistence', async () => {
  const f = await fixture()
  await f.store.proveOwner({
    sessionId: 'target-pending',
    fence: f.fence,
    now: f.now,
    conversationOrigin: f.origin,
    acquisitionGeneration: 'child-1'
  })
  await expect(
    f.store.publishProviderHandle({
      sessionId: 'target-pending',
      fence: f.fence + 1,
      acquisitionGeneration: 'child-1',
      link: f.link,
      now: f.now
    })
  ).rejects.toThrow()
  await f.store.transitionHandoff('target-pending', (record) => ({
    ...record,
    providerHandleChain: [f.link],
    lease: { ...record.lease, provenHandleLinkId: f.link.linkId }
  }))
  await expect(
    f.store.publishProviderHandle({
      sessionId: 'target-pending',
      fence: f.fence,
      acquisitionGeneration: 'child-1',
      now: f.now
    })
  ).rejects.toThrow('unverified')
  expect(
    readConversationFreshNativeProof(f.db, {
      sessionId: 'target-pending',
      operationKey: f.intent.operationKey
    })
  ).toBeNull()
})

it('does not classify queue admission, edit or hold as pending native effects', async () => {
  const f = await fixture()
  await f.store.proveOwner({
    sessionId: 'target-pending',
    fence: f.fence,
    now: f.now,
    conversationOrigin: f.origin,
    acquisitionGeneration: 'child-1'
  })
  const { createConversationOriginRowHook } = await import('./conversation-origin-rows')
  const journal = await openAgentSessionJournal({
    database: openTestJournalHostDatabase(f.root),
    identity: {
      sessionId: 'target-pending',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    },
    requiredInTransaction: createConversationOriginRowHook('target-pending')
  })
  try {
    await journal.rollEpoch('session_created', f.fence)
    const card = await journal.queuedMessages.insert({
      messageId: 'draft',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'unsent candidate draft' }]
      }
    })
    await journal.queuedMessages.update({
      messageId: 'draft',
      expectedBodyFingerprint: card.fingerprint,
      text: 'edited unsent draft'
    })
    await journal.queuedMessages.hold({ messageIds: ['draft'], reason: 'send_failed' })
    expect(
      f.db
        .prepare(
          'SELECT effect_seen FROM conversation_pending_native_identity WHERE session_id=? AND fence=?'
        )
        .get('target-pending', f.fence)?.effect_seen
    ).toBe(0)
    await f.store.publishProviderHandle({
      sessionId: 'target-pending',
      fence: f.fence,
      acquisitionGeneration: 'child-1',
      link: f.link,
      now: f.now
    })
    expect(
      readConversationFreshNativeProof(f.db, {
        sessionId: 'target-pending',
        operationKey: f.intent.operationKey
      })
    ).not.toBeNull()
  } finally {
    await journal.close()
  }
})
