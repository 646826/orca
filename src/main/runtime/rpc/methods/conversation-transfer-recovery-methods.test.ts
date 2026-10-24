import { afterEach, assert, expect, it } from 'vitest'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  NATIVE_CONVERSATION_RUNTIME_CAPABILITY,
  NATIVE_CONVERSATION_READ_CAPABILITY,
  NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY
} from '../../../../shared/conversation-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES } from '../../../../shared/structured-agent-session-renderer-client-capabilities'
import { ConversationSurfaceSnapshotSchema } from '../../../../shared/conversation-surface-rpc'
import { ConversationTransferRecoveryParams } from '../../../../shared/conversation-transfer-recovery'
import { CONVERSATION_SURFACE_METHODS } from './conversation-surface-methods'
import { CONVERSATION_TRANSFER_RECOVERY_METHODS } from './conversation-transfer-recovery-methods'
import { call } from './structured-agent-session-rpc.test-fixture'

afterEach(() => setStructuredAgentSessionHost(null))
const request = {
  operationKey: 'op',
  transferId: 'transfer',
  expectedVersion: 1,
  expectedRevision: 1,
  expectedContextGeneration: 1,
  expectedActivationFence: 1,
  expectedNativeBindingGeneration: 1,
  expectedRuntimeFence: 1,
  expectedTargetEpoch: 'epoch',
  expectedRecoveryAttempt: 0,
  expectedProofDigest: 'a'.repeat(64),
  action: 'return-held-draft',
  clientOperationId: `1800000000000-${'1'.repeat(32)}`
}

it('omits the added field for an old strict v2 reader and advertises it only to capable readers', async () => {
  await attach()
  const { host } = hostTestState()
  setStructuredAgentSessionHost(host)
  const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  const caps = STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES.filter(
    (cap) => cap !== NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY
  )
  const old = await call(
    'conversation.surfaceRead',
    { conversationId: conversation.conversationId },
    { clientKind: 'runtime', clientCapabilities: caps },
    {},
    CONVERSATION_SURFACE_METHODS
  )
  assert('result' in old)
  const oldSchema = ConversationSurfaceSnapshotSchema.omit({ transferRecovery: true }).strict()
  expect(oldSchema.safeParse(old.result).success).toBe(true)
  expect(old.result).not.toHaveProperty('transferRecovery')
  const modern = await call(
    'conversation.surfaceRead',
    { conversationId: conversation.conversationId },
    {
      clientKind: 'runtime',
      clientCapabilities: [...STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES]
    },
    {},
    CONVERSATION_SURFACE_METHODS
  )
  assert('result' in modern)
  expect(modern.result).toMatchObject({
    transferRecovery: { version: 1, intentions: [], next: null }
  })
  const parsed = ConversationSurfaceSnapshotSchema.parse(modern.result)
  const { transferRecovery: _capability, ...snapshotWithoutRecovery } = parsed
  expect(snapshotWithoutRecovery).toEqual(old.result)
})

it.each([
  { capabilities: [NATIVE_CONVERSATION_RUNTIME_CAPABILITY] },
  { capabilities: [NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY] },
  {
    capabilities: [
      NATIVE_CONVERSATION_READ_CAPABILITY,
      NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY
    ]
  }
])('never grants mutation from either missing capability alone: %j', async ({ capabilities }) => {
  const reply = await call(
    'conversation.recoverTransfer',
    request,
    { clientKind: 'runtime', clientId: 'authenticated', clientCapabilities: capabilities },
    {},
    CONVERSATION_TRANSFER_RECOVERY_METHODS
  )
  expect(reply).toHaveProperty('error')
})

it.each([false, true])(
  'a mobile client cannot mutate a transfer, even claiming full capability: %j',
  async (full) => {
    const reply = await call(
      'conversation.recoverTransfer',
      request,
      {
        clientKind: 'mobile',
        pairedDeviceId: 'device',
        clientCapabilities: [
          ...(full ? STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES : []),
          NATIVE_CONVERSATION_READ_CAPABILITY,
          NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY
        ]
      },
      {},
      CONVERSATION_TRANSFER_RECOVERY_METHODS
    )
    expect(reply).toMatchObject({
      error: { code: 'conversation_refused', data: { reason: 'unsupported' } }
    })
  }
)

it('never accepts a client body, stale target replacement, or unsupported direct retry action', () => {
  expect(ConversationTransferRecoveryParams.safeParse(request).success).toBe(true)
  expect(
    ConversationTransferRecoveryParams.safeParse({ ...request, body: 'pretend original' }).success
  ).toBe(false)
  expect(
    ConversationTransferRecoveryParams.safeParse({ ...request, targetSessionId: 'other' }).success
  ).toBe(false)
  expect(
    ConversationTransferRecoveryParams.safeParse({ ...request, action: 'retry-target' }).success
  ).toBe(false)
})
