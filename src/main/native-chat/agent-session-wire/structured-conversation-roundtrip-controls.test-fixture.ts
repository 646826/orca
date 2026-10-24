import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { CALLER } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'

export function createConversationRoundtripControls(host: StructuredAgentSessionHost) {
  const store = host.deps.store
  const send = (sessionId: string, text: string, queue = false) =>
    host.send(CALLER, {
      ...structuredAgentSessionMessageSendMutation({
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(sessionId)!.lease.runtimeFence,
        body: hostTestMessage(text),
        ...(queue ? { delivery: 'queue-if-active' as const } : {})
      }),
      userSend: true
    })
  const approve = (intent: ConversationSwitchIntent) => {
    const controls = host.deps.conversationPreparationControls!
    const view = controls.read(intent.operationKey)!
    if (!view.target) {
      throw new Error(`target unavailable ${JSON.stringify(view)}`)
    }
    controls.approveRecipient(
      {
        operationKey: intent.operationKey,
        expectedVersion: view.operationVersion,
        expectedContextGeneration: view.contextGeneration,
        expectedApprovalRevision: view.approvalRevision,
        targetBindingDigest: view.target.bindingDigest,
        capabilityFingerprint: view.target.capabilityFingerprint,
        policy: 'budgeted',
        disclosure: 'available-canonical'
      },
      CALLER.callerKey
    )
  }
  const consent = (intent: ConversationSwitchIntent) => {
    const controls = host.deps.conversationPreparationControls!
    const view = controls.read(intent.operationKey)!,
      preview = view.preview!
    expect(preview.sourceCount).toBeGreaterThan(0)
    controls.approveManifest(
      {
        operationKey: intent.operationKey,
        expectedVersion: view.operationVersion,
        expectedContextGeneration: view.contextGeneration,
        manifestDigest: preview.manifestDigest,
        targetBindingDigest: preview.targetBindingDigest,
        capabilityFingerprint: preview.capabilityFingerprint,
        transformationsDigest: preview.transformationsDigest,
        omissionsDigest: preview.omissionsDigest
      },
      CALLER.callerKey
    )
  }
  const enrollSource = async (overrides: Partial<AgentSessionAttachParams> = {}) => {
    expect(
      await host.attach(
        CALLER,
        hostTestAttachParams(null, { providerHandle: undefined, ...overrides })
      )
    ).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.length).toBeGreaterThan(0)
    )
    await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  }
  const foundTarget = async (
    sourceSessionId: string,
    targetId: string,
    overrides: Partial<AgentSessionAttachParams> = {}
  ) => {
    const route = store.conversations.route(sourceSessionId)
    if (route.role === 'unbound') {
      throw new Error('source conversation missing')
    }
    const conversation = store.conversations.read(route.conversationId)!
    const operation = {
      callerKey: CALLER.callerKey,
      operationId: hostTestOperationId(),
      fingerprint: 'roundtrip-found',
      now: HOST_TEST_NOW
    }
    const params = hostTestAttachParams(null, {
      providerHandle: undefined,
      ...overrides
    })
    params.envelope = {
      sessionId: targetId,
      clientOperationId: operation.operationId,
      payloadFingerprint: operation.fingerprint,
      expectedRuntimeFence: null
    }
    const begun = await host.conversationEnrollment.found(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence,
        expectedNativeBindingGeneration: 1,
        target: {
          sessionId: targetId,
          provider: params.provider,
          location: params.location,
          accountHome: params.accountHome
        }
      },
      operation,
      params,
      {}
    )
    return begun.intent!
  }
  const beginReturn = async (sourceSessionId: string, targetSessionId: string) => {
    const route = store.conversations.route(sourceSessionId)
    if (route.role === 'unbound') {
      throw new Error('Source conversation missing')
    }
    const current = store.conversations.read(route.conversationId)!
    const back = await store.conversations.beginSwitch(
      {
        conversationId: current.conversationId,
        expectedRevision: current.revision,
        expectedContextGeneration: current.contextGeneration,
        expectedActivationFence: current.activationFence,
        expectedNativeBindingGeneration: 1,
        target: store.getRecord(targetSessionId)!
      },
      {
        callerKey: CALLER.callerKey,
        operationId: hostTestOperationId(),
        fingerprint: 'roundtrip-return',
        now: HOST_TEST_NOW
      }
    )
    return back.intent!
  }
  return { send, approve, consent, enrollSource, foundTarget, beginReturn }
}
