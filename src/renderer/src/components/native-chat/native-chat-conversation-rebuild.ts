import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  ConversationOperationViewSchema,
  ConversationSurfaceSnapshotSchema,
  type ConversationSelectAgentRequest,
  type ConversationSurfaceSnapshot
} from '../../../../shared/conversation-surface-rpc'

/** Explicit user action only. Lost cancel responses and possible dispatch never imply safe replay. */
export async function prepareConversationNativeRebuild(
  target: RuntimeClientTarget,
  snapshot: ConversationSurfaceSnapshot,
  clientOperationId: string,
  options: {
    signal?: AbortSignal
    expectedEnvironmentPairingRevision?: number
    beforeSend?: () => void
  } = {}
): Promise<ConversationSelectAgentRequest> {
  const original = snapshot.conversation
  const pending = snapshot.operation
  let current = snapshot
  const agent = snapshot.selected?.agent ?? snapshot.active.agent
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') {
    throw new Error('Unsupported native agent')
  }
  if (original.pendingOperationKey) {
    if (!pending || !['quiescing', 'prepared'].includes(pending.phase)) {
      throw new Error('Reconcile the pending switch before rebuilding its native session')
    }
    if (snapshot.selected?.sessionId !== pending.targetSessionId) {
      throw new Error('Selected native target is unavailable')
    }
    const cancelled = ConversationOperationViewSchema.parse(
      await callRuntimeRpc(
        target,
        'conversation.cancel',
        {
          operationKey: pending.operationKey,
          expectedVersion: pending.version,
          expectedRevision: original.revision,
          expectedContextGeneration: original.contextGeneration,
          expectedActivationFence: original.activationFence
        },
        options
      )
    )
    if (cancelled.phase !== 'cancelled' || cancelled.operationKey !== pending.operationKey) {
      throw new Error('Native switch cancellation is not confirmed')
    }
    current = ConversationSurfaceSnapshotSchema.parse(
      await callRuntimeRpc(
        target,
        'conversation.surfaceRead',
        {
          conversationId: original.conversationId
        },
        options
      )
    )
    if (
      current.conversation.conversationId !== original.conversationId ||
      current.conversation.pendingOperationKey ||
      current.conversation.contextGeneration !== original.contextGeneration ||
      current.conversation.activeSegmentId !== original.activeSegmentId ||
      current.conversation.activationFence !== original.activationFence
    ) {
      throw new Error('Conversation changed before native rebuild')
    }
  }
  return {
    conversationId: current.conversation.conversationId,
    expectedRevision: current.conversation.revision,
    expectedContextGeneration: current.conversation.contextGeneration,
    expectedActivationFence: current.conversation.activationFence,
    agent,
    nativeSession: 'rebuild' as const,
    clientOperationId
  }
}
