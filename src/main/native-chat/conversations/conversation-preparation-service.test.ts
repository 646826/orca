import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { readSegments } from './conversation-read-model'
import type { ConversationPreparationTarget } from './conversation-preparation-authority'
import {
  readConversationPreparationConsent,
  approveConversationPreparation
} from './conversation-preparation-consent'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import {
  conversationContextAccountDigest,
  verifyConversationContextEvidence
} from './conversation-context-authority'
import { compileConversationContext } from './conversation-context-policy'
import {
  conversationContextDigest,
  consentForConversationManifest
} from './conversation-context-consent'
import { approveConversationPreparationRequest } from './conversation-preparation-request'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { createConversationPreparationService } from './conversation-preparation-service'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
const historyRoots: string[] = []
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const root of historyRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('production preparation refuses missing recipient authorization before reading native target or exporting', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const root = mkdtempSync(join(tmpdir(), 'orca-preparation-'))
  const service = createConversationPreparationService({
    db: f.host.db,
    stateDirectory: root,
    store: () =>
      new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
        hasSession: () => true
      }),
    readTarget: () => {
      throw new Error('unauthorized native read')
    },
    now: () => 1
  })
  const result = await service.preparation.prepare(
    f.records.conversations.intent(f.operationKey)!,
    null,
    new AbortController().signal,
    null
  )
  expect(result).toEqual({ kind: 'blocked', reasons: ['recipient-approval-required'] })
  rmSync(root, { recursive: true, force: true })
})

test('real canonical export waits for exact manifest consent then publishes a first-turn plan', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const root = mkdtempSync(join(tmpdir(), 'orca-preparation-positive-'))
  const intent = f.records.conversations.intent(f.operationKey)!
  const observed: ConversationPreparationTarget = {
    target: {
      sessionId: intent.targetSessionId,
      provider: 'codex',
      accountBindingDigest: conversationContextAccountDigest(
        f.records.getRecord(intent.targetSessionId)!
      ),
      nativeBindingGeneration: intent.nativeBindingGeneration,
      capabilityFingerprint: 'caps',
      model: 'provider-default (unreported)',
      retrieval: 'unsupported' as const
    },
    budget: null,
    nativeIdentityDigest: 'native',
    runtimeFence: 1,
    optionsDigest: 'options',
    freshNative: false,
    workspaceObservation: {
      scopeDigest: 'folder',
      watchIdentity: 'watch',
      revision: 1,
      continuity: 'observed'
    }
  }
  const service = createConversationPreparationService({
    db: f.host.db,
    stateDirectory: root,
    store: () =>
      new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
        hasSession: () => true
      }),
    readTarget: () => observed,
    now: () => 1
  })
  approveConversationPreparationRequest(
    f.host.db,
    {
      operationKey: intent.operationKey,
      expectedVersion: intent.version,
      expectedContextGeneration: intent.contextGeneration,
      targetSessionId: intent.targetSessionId,
      targetBindingDigest: conversationContextDigest(observed.target),
      capabilityFingerprint: 'caps',
      policy: 'budgeted',
      disclosure: 'available-canonical'
    },
    'caller'
  )
  try {
    expect(
      await service.preparation.prepare(intent, null, new AbortController().signal, null)
    ).toEqual({ kind: 'waiting-consent' })
    const row = f.host.db
      .prepare('SELECT manifest_id FROM conversation_preparation_previews WHERE operation_key=?')
      .get(intent.operationKey)
    const preview = service.authority.readPreview(String(row?.manifest_id))!
    expect(preview.manifest.projection.length).toBeGreaterThan(0)
    expect(preview.manifest.inputTokens).toBeNull()
    expect(service.controls.read(intent.operationKey)?.preview).toMatchObject({
      inputEstimate: null,
      estimateConfidence: 'unknown'
    })
    expect(service.readPreparationEvidence(f.host.db, preview.manifest)).not.toBeNull()
    const { approvedBy: _caller, ...digests } = consentForConversationManifest(
      preview.manifest,
      'unused'
    )
    approveConversationPreparation(
      f.host.db,
      {
        ...digests,
        operationKey: intent.operationKey,
        expectedVersion: intent.version,
        expectedContextGeneration: intent.contextGeneration
      },
      'caller',
      service.authority
    )
    expect(
      await service.preparation.prepare(intent, null, new AbortController().signal, null)
    ).toMatchObject({
      kind: 'prepared',
      plan: {
        manifestId: preview.manifest.manifestId,
        delivery: 'first-turn',
        sourceBoundaries: preview.sources.boundaries
      }
    })
    expect(service.controls.read(intent.operationKey)?.workspaceObservation).toBe(
      'no-change-observed'
    )
    observed.workspaceObservation = {
      scopeDigest: 'folder',
      watchIdentity: 'watch',
      revision: 2,
      continuity: 'observed'
    }
    expect(service.preparation.readPlan(preview.manifest.manifestId)).toBeNull()
    expect(service.controls.read(intent.operationKey)).toMatchObject({
      status: 'stale',
      workspaceObservation: 'observed-change'
    })
    await expect(
      service.preparation.prepare(
        intent,
        preview.manifest.manifestId,
        new AbortController().signal,
        null
      )
    ).resolves.toEqual({ kind: 'waiting-consent' })
    const renewed = service.controls.read(intent.operationKey)
    expect(renewed?.preview?.manifestDigest).not.toBe(preview.manifest.digest)
    expect(renewed?.preview?.consented).toBe(false)
    approveConversationPreparationRequest(
      f.host.db,
      {
        operationKey: intent.operationKey,
        expectedVersion: intent.version,
        expectedContextGeneration: intent.contextGeneration,
        targetSessionId: intent.targetSessionId,
        targetBindingDigest: conversationContextDigest(observed.target),
        capabilityFingerprint: 'caps',
        policy: 'full',
        disclosure: 'available-canonical',
        expectedApprovalRevision: 1
      },
      'caller'
    )
    expect(service.readPreparationEvidence(f.host.db, preview.manifest)).toBeNull()
    expect(
      await service.preparation.prepare(intent, null, new AbortController().signal, null)
    ).toEqual({ kind: 'blocked', reasons: ['unknown-budget'] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('late original evidence invalidates a saved plan and rebuilds a preview requiring new consent', async () => {
  const f = await historyService('budgeted')
  await expect(f.service.preparation.prepare(f.intent, null, f.signal, null)).resolves.toEqual({
    kind: 'waiting-consent'
  })
  const first = f.preview()
  f.approve(first)
  await expect(
    f.service.preparation.prepare(f.intent, null, f.signal, null)
  ).resolves.toMatchObject({ kind: 'prepared' })
  f.append(7, 'codex:message:late', 1, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Late test result: keep the no-network constraint.' }]
  })
  expect(f.service.preparation.readPlan(first.manifest.manifestId)).toBeNull()
  await expect(
    f.service.preparation.prepare(f.intent, first.manifest.manifestId, f.signal, null)
  ).resolves.toEqual({ kind: 'waiting-consent' })
  const second = f.preview()
  expect(second.manifest.manifestId).not.toBe(first.manifest.manifestId)
  expect(second.manifest.projection.map((p) => p.text).join('\n')).toContain('Late test result')
  expect(readConversationPreparationConsent(f.host.db, second.manifest.manifestId)).toBeNull()
  f.approve(second)
  await expect(
    f.service.preparation.prepare(f.intent, second.manifest.manifestId, f.signal, null)
  ).resolves.toMatchObject({ kind: 'prepared' })
  f.host.db.prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?').run(second.sources.ownerId)
  expect(() => f.service.preparation.readPlan(second.manifest.manifestId)).toThrow('pin')
  await expect(
    f.service.preparation.prepare(f.intent, second.manifest.manifestId, f.signal, null)
  ).rejects.toThrow('pin')
})

test('synthetic verified full budget preserves actual user, revised assistant and tool invocation/result bytes', async () => {
  const f = await historyService('full')
  const result = await f.service.preparation.prepare(f.intent, null, f.signal, null)
  expect(result.kind).toBe('prepared')
  const preview = f.preview()
  expect(preview.manifest.completeness).toBe('available-canonical')
  expect(preview.sources.enumeration.sourceCount).toBe(6)
  expect(preview.manifest.projection.every((p) => p.representation === 'exact')).toBe(true)
  const text = preview.manifest.projection.map((p) => p.text).join('\n')
  for (const expected of [
    'Never access the network',
    'Use cache v1',
    'Revised decision: use cache v2',
    'check-cache',
    'cache v2 verified'
  ]) {
    expect(text).toContain(expected)
  }
  for (const part of preview.manifest.projection) {
    const row = f.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(part.version.source.sessionId, part.version.source.epoch, part.version.source.sequence)
    expect(part.text).toBe(row?.row_json)
  }
})

async function historyService(
  policy: 'budgeted' | 'full',
  retrieval: 'verified' | 'unsupported' = 'unsupported'
) {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const root = mkdtempSync(join(tmpdir(), 'orca-preparation-history-'))
  historyRoots.push(root)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  const append = (seq: number, itemId: string, revision: number, body: AgentJournalItemBody) =>
    f.host.transaction((db) => {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq,
        ts: seq,
        fence: 1,
        itemId,
        revision,
        body
      })
      attributeConversationSourceBoundary(
        db,
        segment.segmentId,
        'session-a',
        intent.contextGeneration,
        { sessionId: 'session-a', epoch: 'epoch-session-a', endSequence: seq }
      )
    })
  append(2, 'codex:message:constraint', 1, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Never access the network. Keep Unicode: 日本語.' }]
  })
  append(3, 'codex:message:decision', 1, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Use cache v1' }]
  })
  append(4, 'codex:message:decision', 2, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Revised decision: use cache v2' }]
  })
  append(5, 'codex:tool:check', 1, {
    kind: 'tool-call',
    name: 'check-cache',
    input: { path: 'cache' },
    state: 'running'
  })
  append(6, 'codex:tool:check', 2, {
    kind: 'tool-call',
    name: 'check-cache',
    input: { path: 'cache' },
    state: 'completed',
    output: { head: 'cache v2 verified', byteLength: 17, digest: 'a'.repeat(64), truncated: false }
  })
  const target = {
    sessionId: intent.targetSessionId,
    provider: 'codex',
    accountBindingDigest: conversationContextAccountDigest(
      f.records.getRecord(intent.targetSessionId)!
    ),
    nativeBindingGeneration: intent.nativeBindingGeneration,
    capabilityFingerprint: 'synthetic-capabilities',
    model: 'synthetic-model',
    retrieval
  }
  const observed: ConversationPreparationTarget = {
    target,
    budget:
      policy === 'full'
        ? {
            capacity: 100000,
            occupied: 0,
            reserved: 10000,
            confidence: 'upper-bound',
            targetFingerprint: target.capabilityFingerprint,
            nativeBindingGeneration: target.nativeBindingGeneration,
            model: target.model,
            accountBindingDigest: target.accountBindingDigest,
            observedAt: 1,
            validUntil: 100
          }
        : null,
    nativeIdentityDigest: 'fixture-native',
    runtimeFence: 1,
    optionsDigest: 'fixture-options',
    freshNative: false
  }
  const service = createConversationPreparationService({
    db: f.host.db,
    stateDirectory: root,
    store: () =>
      new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
        hasSession: () => true
      }),
    readTarget: () => observed,
    now: () => 2,
    fullEstimator: () => ({
      countTokens: (text) => Buffer.byteLength(text),
      confidence: 'upper-bound'
    })
  })
  approveConversationPreparationRequest(
    f.host.db,
    {
      operationKey: intent.operationKey,
      expectedVersion: intent.version,
      expectedContextGeneration: intent.contextGeneration,
      targetSessionId: target.sessionId,
      targetBindingDigest: conversationContextDigest(target),
      capabilityFingerprint: target.capabilityFingerprint,
      policy,
      disclosure: 'available-canonical'
    },
    'caller'
  )
  const preview = () =>
    service.authority.readPreview(
      String(
        f.host.db
          .prepare(
            'SELECT manifest_id FROM conversation_preparation_previews ORDER BY rowid DESC LIMIT 1'
          )
          .get()?.manifest_id
      )
    )!
  const approve = (p: ReturnType<typeof preview>) => {
    const { approvedBy: _caller, ...digests } = consentForConversationManifest(p.manifest, 'unused')
    approveConversationPreparation(
      f.host.db,
      {
        ...digests,
        operationKey: intent.operationKey,
        expectedVersion: intent.version,
        expectedContextGeneration: intent.contextGeneration
      },
      'caller',
      service.authority
    )
  }
  return {
    ...f,
    intent,
    service,
    append,
    preview,
    approve,
    observed,
    signal: new AbortController().signal
  }
}

test.each(['coverage', 'native-identity'] as const)(
  'invalidates approved budgeted preparation when %s changes before delivery',
  async (changed) => {
    const f = await historyService('budgeted')
    expect(await f.service.preparation.prepare(f.intent, null, f.signal, null)).toEqual({
      kind: 'waiting-consent'
    })
    const first = f.preview()
    f.approve(first)
    expect(await f.service.preparation.prepare(f.intent, null, f.signal, null)).toMatchObject({
      kind: 'prepared'
    })
    expect(f.service.preparation.readPlan(first.manifest.manifestId)).not.toBeNull()
    if (changed === 'coverage') {
      f.host.db
        .prepare('UPDATE conversation_context_coverage_revision SET revision=revision+1')
        .run()
    } else {
      f.observed.nativeIdentityDigest = 'replacement-native'
    }
    expect(f.service.preparation.readPlan(first.manifest.manifestId)).toBeNull()
    expect(f.service.controls.read(f.intent.operationKey)?.status).toBe('stale')
    expect(
      await f.service.preparation.prepare(f.intent, first.manifest.manifestId, f.signal, null)
    ).toEqual({ kind: 'waiting-consent' })
    expect(f.preview().manifest.digest).not.toBe(first.manifest.digest)
    expect(
      readConversationPreparationConsent(f.host.db, f.preview().manifest.manifestId)
    ).toBeNull()
  }
)

test('production budgeted preparation preserves a large tool original and requires exact projection consent', async () => {
  const f = await historyService('budgeted', 'verified')
  f.append(7, 'codex:tool:check', 3, {
    kind: 'tool-call',
    name: 'check-cache',
    input: { path: 'cache' },
    state: 'completed',
    output: {
      head: `${'甲🙂'.repeat(200000)}last-result`,
      byteLength: 1400011,
      digest: 'a'.repeat(64),
      truncated: false
    }
  })
  expect(await f.service.preparation.prepare(f.intent, null, f.signal, null)).toEqual({
    kind: 'waiting-consent'
  })
  const preview = f.preview()
  expect(preview.sources.enumeration.sourceCount).toBe(7)
  expect(preview.manifest.completeness).toBe('budgeted-projection')
  expect(
    preview.manifest.projection.find((part) => part.version.source.sequence === 7)
  ).toMatchObject({ representation: 'summarized', artifactId: expect.any(String) })
  expect(
    preview.manifest.projection.find((part) => part.version.source.sequence === 2)?.text
  ).toContain('Never access the network')
  f.approve(preview)
  expect(
    await f.service.preparation.prepare(f.intent, preview.manifest.manifestId, f.signal, null)
  ).toMatchObject({ kind: 'prepared' })
})

test('retains legacy full preview bytes but refuses renewed dispatch without verified estimator confidence', async () => {
  const f = await historyService('full')
  expect((await f.service.preparation.prepare(f.intent, null, f.signal, null)).kind).toBe(
    'prepared'
  )
  const preview = f.preview()
  expect(f.service.authority.readPreparationEvidence(f.host.db, preview.manifest)).not.toBeNull()
  const compiled = compileConversationContext({
    ...preview.manifest,
    evidenceIndex: undefined,
    originals: preview.manifest.projection.map((part) => ({
      version: part.version,
      text: part.text,
      artifactId: part.artifactId,
      kind: 'historical-data' as const,
      gaps: []
    })),
    countTokens: (text) => Buffer.byteLength(text),
    inputTokenConfidence: 'upper-bound',
    now: 2,
    signal: f.signal
  })
  if (compiled.kind !== 'compiled') {
    throw new Error(compiled.reason)
  }
  const {
    manifestId: _id,
    digest: _digest,
    inputTokenConfidence: _confidence,
    ...body
  } = compiled.manifest
  const digest = conversationContextDigest(body)
  const legacy = { ...body, manifestId: digest, digest }
  const serialized = JSON.stringify(legacy)
  // Upgrade fixture: persist the former shape, never forge an acceptance or disable immutability.
  f.host.db
    .prepare('INSERT INTO conversation_preparation_previews VALUES(?,?,?,?,?,?,?)')
    .run(
      legacy.manifestId,
      f.intent.operationKey,
      preview.sources.ownerId,
      serialized,
      JSON.stringify(preview.target),
      'null',
      JSON.stringify({ proofId: 'legacy-preview' })
    )
  expect(f.service.authority.readPreview(legacy.manifestId)?.manifest).toEqual(legacy)
  expect(f.service.authority.readPreparationEvidence(f.host.db, legacy)).toBeNull()
  expect(() =>
    f.host.transaction(() =>
      f.service.authority.publish({
        manifest: legacy,
        sourceOwnerId: preview.sources.ownerId,
        target: preview.target,
        trigger: null
      })
    )
  ).toThrow('verified input estimate')
  expect(() =>
    verifyConversationContextEvidence(
      f.host.db,
      legacy,
      f.service.authority.readPreparationEvidence
    )
  ).toThrow('unverified')
  expect(
    f.host.db
      .prepare('SELECT manifest_json FROM conversation_preparation_previews WHERE manifest_id=?')
      .get(legacy.manifestId)?.manifest_json
  ).toBe(serialized)
})
