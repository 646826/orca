import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { createConversationPreparationAuthority } from './conversation-preparation-authority'
import { createConversationPreparationControls } from './conversation-preparation-controls'
import { conversationContextAccountDigest } from './conversation-context-authority'
import { readConversationPreparationRequest } from './conversation-preparation-request'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('controls expose safe target binding and derive recipient approval from current host identity', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
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
    nativeIdentityDigest: 'secret-native-id',
    runtimeFence: 1,
    optionsDigest: 'options',
    freshNative: false
  }
  const authority = createConversationPreparationAuthority(
    f.host.db,
    () => observed,
    () => 1
  )
  const controls = createConversationPreparationControls({
    db: f.host.db,
    readTarget: () => observed,
    authority,
    readEvidence: authority.readPreparationEvidence
  })
  const view = controls.read(f.operationKey)!
  expect(view.target?.sessionId).toBe(intent.targetSessionId)
  expect(view.activeSessionId).toBe('session-a')
  expect(view.selectedSessionId).toBe('session-b')
  expect(JSON.stringify(view)).not.toContain('secret-native-id')
  expect(JSON.stringify(view)).not.toContain('/accounts')
  const choice = {
    operationKey: f.operationKey,
    expectedVersion: intent.version,
    expectedContextGeneration: 1,
    expectedApprovalRevision: 0,
    targetBindingDigest: view.target!.bindingDigest,
    capabilityFingerprint: 'caps',
    policy: 'budgeted' as const,
    disclosure: 'available-canonical' as const
  }
  expect(() =>
    controls.approveRecipient({ ...choice, targetBindingDigest: 'forged' }, 'caller')
  ).toThrow()
  controls.approveRecipient(choice, 'trusted-caller')
  expect(readConversationPreparationRequest(f.host.db, f.operationKey)?.authorizedCallerKey).toBe(
    'trusted-caller'
  )
  expect(controls.read(f.operationKey)?.approvalRevision).toBe(1)
  expect(() => controls.approveRecipient({ ...choice, policy: 'full' }, 'trusted-caller')).toThrow()
  expect(() =>
    controls.approveManifest(
      {
        operationKey: f.operationKey,
        expectedVersion: intent.version,
        expectedContextGeneration: 1,
        manifestDigest: 'a'.repeat(64),
        targetBindingDigest: view.target!.bindingDigest,
        capabilityFingerprint: 'caps',
        transformationsDigest: 'b'.repeat(64),
        omissionsDigest: 'c'.repeat(64)
      },
      'trusted-caller'
    )
  ).toThrow()
})
