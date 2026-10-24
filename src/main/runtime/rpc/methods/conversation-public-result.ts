import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import type { ConversationSwitchIntent } from '../../../../shared/conversation-record'
import type { ConversationOperationView } from '../../../../shared/conversation-rpc'
export function conversationOperationView(
  intent: ConversationSwitchIntent
): ConversationOperationView {
  const {
    operationKey,
    conversationId,
    targetSessionId,
    candidateSegmentId,
    contextGeneration,
    activationFence,
    nativeBindingGeneration,
    version,
    phase
  } = intent
  return {
    operationKey,
    conversationId,
    targetSessionId,
    candidateSegmentId,
    contextGeneration,
    activationFence,
    nativeBindingGeneration,
    version,
    phase,
    sourceBoundaryCount: intent.sourceBoundaries.length,
    candidateBoundaryCount: intent.candidateBaseline.length
  }
}
/** Refuse an oversized metadata response; never silently trim identity or source coordinates. */
export function boundedConversationResult<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) {
    throw new ConversationRpcRefusal('resource-limit')
  }
  return value
}
