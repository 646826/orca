import { expect, test } from 'vitest'
import {
  ConversationReadParams,
  ConversationSwitchParams,
  ConversationRecipientParams
} from './conversation-params'

test('conversation reads bound pages and reject caller-selected storage paths', () => {
  expect(
    ConversationReadParams.safeParse({ conversationId: 'conversation', limit: 257 }).success
  ).toBe(false)
  expect(
    ConversationReadParams.safeParse({ conversationId: 'conversation', path: '/private' }).success
  ).toBe(false)
  expect(ConversationReadParams.parse({ conversationId: 'conversation' }).limit).toBe(128)
})

test('switch requests require generation fences and reject client-supplied native authority', () => {
  const request = {
    conversationId: 'conversation',
    targetSessionId: 'agent-session-0123456789abcdef0123456789abcdef',
    clientOperationId: '1800000000000-00000000000000000000000000000001',
    expectedRevision: 1,
    expectedContextGeneration: 1,
    expectedActivationFence: 1,
    expectedNativeBindingGeneration: 1
  }
  expect(ConversationSwitchParams.safeParse(request).success).toBe(true)
  expect(
    ConversationSwitchParams.safeParse({ ...request, clientOperationId: 'operation' }).success
  ).toBe(false)
  expect(
    ConversationSwitchParams.safeParse({ ...request, expectedContextGeneration: 0 }).success
  ).toBe(false)
  expect(
    ConversationSwitchParams.safeParse({ ...request, authorizedCallerKey: 'other' }).success
  ).toBe(false)
  expect(ConversationSwitchParams.safeParse({ ...request, accountHome: '/private' }).success).toBe(
    false
  )
  expect(ConversationSwitchParams.safeParse({ ...request, receipt: 'accepted' }).success).toBe(
    false
  )
})

test('approval requests reject caller and manifest body authority while retaining exact digests', () => {
  const request = {
    operationKey: 'operation',
    expectedVersion: 1,
    expectedContextGeneration: 1,
    expectedApprovalRevision: 0,
    targetBindingDigest: 'a'.repeat(64),
    capabilityFingerprint: 'caps',
    policy: 'budgeted',
    disclosure: 'available-canonical'
  }
  expect(ConversationRecipientParams.safeParse(request).success).toBe(true)
  for (const extra of [
    { callerKey: 'forged' },
    { nativeIdentity: 'forged' },
    { targetSessionId: 'other' },
    { projection: [] }
  ]) {
    expect(ConversationRecipientParams.safeParse({ ...request, ...extra }).success).toBe(false)
  }
  expect(
    ConversationRecipientParams.safeParse({ ...request, expectedApprovalRevision: -1 }).success
  ).toBe(false)
})
