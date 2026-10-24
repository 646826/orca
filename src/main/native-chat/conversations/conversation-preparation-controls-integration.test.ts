import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { createConversationPreparationService } from './conversation-preparation-service'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { conversationContextAccountDigest } from './conversation-context-authority'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('actual prepared index exposes unknown total gaps and manifest-bound pages; changed target invalidates consent evidence', async () => {
  const f = await createConversationSwitchFixture('Keep the original constraint.')
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  let optionsDigest = 'options'
  const observed = {
    target: {
      sessionId: intent.targetSessionId,
      provider: 'codex',
      accountBindingDigest: conversationContextAccountDigest(
        f.records.getRecord(intent.targetSessionId)!
      ),
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'provider-default (unreported)',
      retrieval: 'unsupported' as const
    },
    budget: null,
    nativeIdentityDigest: 'native',
    runtimeFence: 1,
    freshNative: false
  }
  const service = createConversationPreparationService({
    db: f.host.db,
    stateDirectory: f.host.stateDirectory,
    store: () =>
      new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(f.host.stateDirectory), {
        hasSession: () => true
      }),
    readTarget: () => ({ ...observed, optionsDigest }),
    now: () => 1
  })
  const initial = service.controls.read(f.operationKey)!
  service.controls.approveRecipient(
    {
      operationKey: f.operationKey,
      expectedVersion: intent.version,
      expectedContextGeneration: 1,
      expectedApprovalRevision: 0,
      targetBindingDigest: initial.target!.bindingDigest,
      capabilityFingerprint: 'caps',
      policy: 'budgeted',
      disclosure: 'available-canonical'
    },
    'trusted-caller'
  )
  expect(
    await service.preparation.prepare(intent, null, new AbortController().signal, null)
  ).toEqual({ kind: 'waiting-consent' })
  const view = service.controls.read(f.operationKey)!
  expect(view.preview).toMatchObject({ gapCount: null, gapCountComplete: false, consented: false })
  const request = {
    operationKey: f.operationKey,
    manifestDigest: view.preview!.manifestDigest,
    after: 0,
    limit: 1
  }
  const first = service.controls.evidence(request)
  expect(first.entries).toHaveLength(1)
  expect(first.manifestDigest).toBe(view.preview!.manifestDigest)
  expect(() => service.controls.evidence({ ...request, manifestDigest: 'a'.repeat(64) })).toThrow()
  optionsDigest = 'changed-options'
  expect(service.controls.read(f.operationKey)?.status).toBe('stale')
  expect(() => service.controls.evidence(request)).toThrow()
})
