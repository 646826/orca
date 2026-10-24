import { afterEach, expect, test } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  approveConversationPreparationRequest,
  readConversationPreparationRequest,
  createConversationPreparationRequestTablesSql
} from './conversation-preparation-request'
const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close()
  }
})
test('disclosure request requires current operation, exact recipient and authorized caller; immutable replay only', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  f.host.db.exec(createConversationPreparationRequestTablesSql())
  const intent = f.records.conversations.intent(f.operationKey)!
  const request = {
    operationKey: f.operationKey,
    expectedVersion: intent.version,
    expectedContextGeneration: intent.contextGeneration,
    targetSessionId: intent.targetSessionId,
    targetBindingDigest: 'target',
    capabilityFingerprint: 'caps',
    policy: 'budgeted' as const,
    disclosure: 'available-canonical' as const
  }
  expect(readConversationPreparationRequest(f.host.db, f.operationKey)).toBeNull()
  expect(() => approveConversationPreparationRequest(f.host.db, request, '')).toThrow()
  expect(() =>
    approveConversationPreparationRequest(f.host.db, { ...request, expectedVersion: 99 }, 'caller')
  ).toThrow()
  expect(() =>
    approveConversationPreparationRequest(
      f.host.db,
      { ...request, targetSessionId: 'other' },
      'caller'
    )
  ).toThrow()
  approveConversationPreparationRequest(f.host.db, request, 'caller')
  expect(readConversationPreparationRequest(f.host.db, f.operationKey)?.authorizedCallerKey).toBe(
    'caller'
  )
  expect(() => approveConversationPreparationRequest(f.host.db, request, 'caller')).not.toThrow()
  expect(() =>
    approveConversationPreparationRequest(
      f.host.db,
      { ...request, targetBindingDigest: 'other' },
      'caller'
    )
  ).toThrow()
  approveConversationPreparationRequest(
    f.host.db,
    { ...request, targetBindingDigest: 'renewed', expectedApprovalRevision: 1 },
    'caller'
  )
  expect(readConversationPreparationRequest(f.host.db, f.operationKey)?.targetBindingDigest).toBe(
    'renewed'
  )
  expect(
    f.host.db.prepare('SELECT count(*) AS n FROM conversation_preparation_requests').get()?.n
  ).toBe(2)
})
