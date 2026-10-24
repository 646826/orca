import type { ConversationWorkspaceObservation } from '../../../shared/conversation-workspace-observation'
import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { freezeConversationPreparationSources } from './conversation-preparation-sources'
import { compileConversationContext } from './conversation-context-policy'
import { conversationContextAccountDigest } from './conversation-context-authority'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import {
  createConversationPreparationAuthority,
  type ConversationPreparationTarget
} from './conversation-preparation-authority'
import {
  approveConversationPreparation,
  readConversationPreparationConsent
} from './conversation-preparation-consent'
import {
  consentForConversationManifest,
  conversationContextDigest
} from './conversation-context-consent'
import { pinQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'

const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close()
  }
})
async function setup() {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const sourceJournal = new AgentSessionJournal({
    database: f.host,
    identity: {
      sessionId: 'session-a',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'session-a' }
    }
  })
  await sourceJournal.open()
  const intent = f.records.conversations.intent(f.operationKey)!
  const sources = await freezeConversationPreparationSources(
    f.host.db,
    intent,
    new AbortController().signal
  )
  const target = {
    sessionId: 'session-b',
    provider: 'codex',
    accountBindingDigest: conversationContextAccountDigest(f.records.getRecord('session-b')!),
    nativeBindingGeneration: 1,
    capabilityFingerprint: 'caps',
    model: 'model',
    retrieval: 'unsupported' as const
  }
  let observed: ConversationPreparationTarget = {
    target,
    budget: null,
    nativeIdentityDigest: 'native',
    runtimeFence: 1,
    optionsDigest: 'options',
    freshNative: true,
    workspaceObservation: undefined
  }
  const compiled = compileConversationContext({
    conversationId: intent.conversationId,
    contextGeneration: 1,
    sourceRevision: sources.sourceRevision,
    target,
    policy: 'fresh',
    originals: [],
    projection: [],
    mandatory: [],
    budget: null,
    countTokens: () => 1,
    signal: new AbortController().signal,
    now: 1
  })
  if (compiled.kind !== 'compiled') {
    throw new Error('fixture compile')
  }
  const authority = createConversationPreparationAuthority(
    f.host.db,
    () => observed,
    () => 1,
    (id) => (id === 'session-a' ? sourceJournal : null)
  )
  return {
    ...f,
    sourceJournal,
    intent,
    sources,
    manifest: compiled.manifest,
    authority,
    observed,
    changeWorkspace: (workspaceObservation: ConversationWorkspaceObservation) => {
      observed = { ...observed, workspaceObservation }
      return observed
    },
    changeTarget: () => {
      observed = { ...observed, optionsDigest: 'changed' }
    }
  }
}
test('manifest echo cannot manufacture preparation authority; durable host snapshot and observation are required', async () => {
  const f = await setup()
  expect(f.authority.readPreparationEvidence(f.host.db, f.manifest)).toBeNull()
  expect(() =>
    runJournalTransaction(f.host.db, () =>
      f.authority.publish({
        manifest: f.manifest,
        sourceOwnerId: 'invented',
        target: f.observed,
        trigger: null
      })
    )
  ).toThrow()
  runJournalTransaction(f.host.db, () =>
    f.authority.publish({
      manifest: f.manifest,
      sourceOwnerId: f.sources.ownerId,
      target: f.observed,
      trigger: null
    })
  )
  expect(f.authority.readPreparationEvidence(f.host.db, f.manifest)?.sourceEnumeration).toEqual(
    f.sources.enumeration
  )
  f.changeTarget()
  expect(f.authority.readPreparationEvidence(f.host.db, f.manifest)).toBeNull()
})
test('preparation is immutable and late source facts invalidate proof', async () => {
  const f = await setup()
  runJournalTransaction(f.host.db, () =>
    f.authority.publish({
      manifest: f.manifest,
      sourceOwnerId: f.sources.ownerId,
      target: f.observed,
      trigger: null
    })
  )
  expect(() =>
    f.host.db.prepare('UPDATE conversation_preparation_previews SET target_json=?').run('{}')
  ).toThrow()
  f.append('session-a', 2)
  expect(f.authority.readPreparationEvidence(f.host.db, f.manifest)).toBeNull()
})
test('consent binds the frozen preview and server-authorized caller, not a generic policy flag', async () => {
  const f = await setup()
  runJournalTransaction(f.host.db, () =>
    f.authority.publish({
      manifest: f.manifest,
      sourceOwnerId: f.sources.ownerId,
      target: f.observed,
      trigger: null
    })
  )
  const { approvedBy: _caller, ...digests } = consentForConversationManifest(f.manifest, 'unused')
  const request = {
    operationKey: f.operationKey,
    expectedVersion: f.intent.version,
    expectedContextGeneration: 1,
    ...digests
  }
  expect(() =>
    approveConversationPreparation(
      f.host.db,
      { ...request, omissionsDigest: 'changed' },
      'actual-caller',
      f.authority
    )
  ).toThrow()
  approveConversationPreparation(f.host.db, request, 'actual-caller', f.authority)
  expect(readConversationPreparationConsent(f.host.db, f.manifest.manifestId)?.approvedBy).toBe(
    'actual-caller'
  )
  f.changeTarget()
  expect(() =>
    approveConversationPreparation(f.host.db, request, 'actual-caller', f.authority)
  ).toThrow()
})
test.each([
  'edit',
  'delete',
  'options',
  'claims',
  'pin',
  'consumed-elsewhere',
  'foreign-source'
] as const)('durable preview refuses %s drift', async (change) => {
  const f = await setup()
  const db = f.host.db
  const card = await f.sourceJournal.queuedMessages.insert({
    messageId: 'draft',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'continue' }] }
  })
  const trigger = {
    queueSessionId: 'session-a',
    messageId: 'draft',
    transferId: 'transfer',
    sourceFingerprint: card.fingerprint,
    attachmentClaimsDigest: conversationContextDigest([]),
    targetOptionsDigest: 'options'
  }
  runJournalTransaction(db, () =>
    f.authority.publish({
      manifest: f.manifest,
      sourceOwnerId: f.sources.ownerId,
      target: f.observed,
      trigger
    })
  )
  expect(() => f.authority.verifyTrigger(f.manifest.manifestId, trigger)).not.toThrow()
  if (change === 'consumed-elsewhere') {
    await f.sourceJournal.appendSubmission(
      {
        clientMessageId: 'another-send',
        body: card.body,
        payloadFingerprint: card.fingerprint,
        fence: 1
      },
      { messageId: 'draft', expect: 'waiting', yieldsToPause: true }
    )
  }
  if (change === 'foreign-source') {
    trigger.queueSessionId = 'session-b'
  }
  if (change === 'edit') {
    await f.sourceJournal.queuedMessages.update({
      messageId: 'draft',
      expectedBodyFingerprint: card.fingerprint,
      text: 'edited'
    })
  }
  if (change === 'delete') {
    await f.sourceJournal.queuedMessages.withdraw(['draft'])
  }
  if (change === 'options') {
    f.changeTarget()
  }
  if (change === 'claims') {
    trigger.attachmentClaimsDigest = 'changed'
  }
  if (change === 'pin') {
    db.prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?').run(f.sources.ownerId)
  }
  expect(() => f.authority.verifyTrigger(f.manifest.manifestId, trigger)).toThrow()
})
test('withdrawn trigger requires pinned original and matching live reservation and rejects cancellation', async () => {
  const f = await setup(),
    db = f.host.db
  const card = await f.sourceJournal.queuedMessages.insert({
    messageId: 'draft',
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  const trigger = {
    queueSessionId: 'session-a',
    messageId: 'draft',
    transferId: 'transfer',
    sourceFingerprint: card.fingerprint,
    attachmentClaimsDigest: conversationContextDigest([]),
    targetOptionsDigest: 'options'
  }
  runJournalTransaction(db, () =>
    f.authority.publish({
      manifest: f.manifest,
      sourceOwnerId: f.sources.ownerId,
      target: f.observed,
      trigger
    })
  )
  runJournalTransaction(db, () =>
    pinQueuedMessageEvidence(db, {
      ownerId: 'conversation-transfer:transfer',
      sourceSessionId: 'session-a',
      messageId: 'draft',
      fingerprint: card.fingerprint,
      queueOrder: { position: card.position, queuedAt: card.queuedAt }
    })
  )
  await f.sourceJournal.queuedMessages.withdraw(['draft'])
  runJournalTransaction(db, () => {
    const binding = {
      ...trigger,
      kind: 'trigger',
      operationKey: f.operationKey,
      conversationId: f.intent.conversationId,
      contextGeneration: 1,
      candidateGeneration: f.intent.activationFence,
      candidateSegmentId: f.intent.candidateSegmentId,
      nativeBindingGeneration: 1,
      expectedQueueState: 'waiting',
      targetSessionId: 'session-b',
      targetSubmissionId: 'target-send',
      targetFingerprint: 'target-fp',
      deliveryPlanId: 'plan',
      manifestId: f.manifest.manifestId,
      manifestDigest: f.manifest.digest
    }
    db.prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(
      'transfer',
      'trigger',
      f.operationKey,
      'session-a',
      'draft',
      'session-b',
      'target-send',
      JSON.stringify(binding),
      'appended'
    )
  })
  expect(f.authority.readPreparationEvidence(db, f.manifest)).not.toBeNull()
  db.prepare('UPDATE conversation_trigger_reservations SET state=? WHERE transfer_id=?').run(
    'cancelled',
    'transfer'
  )
  expect(f.authority.readPreparationEvidence(db, f.manifest)).toBeNull()
})

test('workspace event invalidates a previously valid frozen preparation proof', async () => {
  const f = await setup()
  const capture = {
    scopeDigest: 'host-folder',
    watchIdentity: 'watch',
    revision: 1,
    continuity: 'observed' as const
  }
  const observed = f.changeWorkspace(capture)
  runJournalTransaction(f.host.db, () =>
    f.authority.publish({
      manifest: f.manifest,
      sourceOwnerId: f.sources.ownerId,
      target: observed,
      trigger: null
    })
  )
  expect(f.authority.readPreparationEvidence(f.host.db, f.manifest)).not.toBeNull()
  f.changeWorkspace({ ...capture, revision: 2 })
  expect(f.authority.readPreparationEvidence(f.host.db, f.manifest)).toBeNull()
})
