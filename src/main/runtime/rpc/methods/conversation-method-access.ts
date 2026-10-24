import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import { sameScope } from '../../../native-chat/conversations/conversation-store-transitions'
import type { RpcContext } from '../core'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience
} from './structured-agent-session-gate'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import {
  NATIVE_CONVERSATION_RUNTIME_CAPABILITY,
  supportsConversationRead
} from '../../../../shared/conversation-runtime-capabilities'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

export async function conversationRpcHost(
  ctx: RpcContext,
  access: 'read' | 'mutation' = 'mutation'
) {
  if (
    ctx.clientKind !== undefined &&
    !(access === 'read'
      ? supportsConversationRead(ctx.clientCapabilities)
      : ctx.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY))
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  return requireInstalledStructuredHost(ctx)
}
export function conversationRpcCaller(ctx: Pick<RpcContext, 'caller' | 'clientKind'>): string {
  if (ctx.caller) {
    return rpcCallerOperationKey(ctx.caller)
  }
  if (ctx.clientKind === undefined) {
    return 'trusted-local:runtime'
  }
  throw new ConversationRpcRefusal('unauthenticated')
}
export function requireConversationRecord(
  host: StructuredAgentSessionHost,
  ctx: RpcContext,
  conversationId: string
) {
  const conversation = host.deps.store.conversations.read(conversationId)
  if (!conversation) {
    throw new ConversationRpcRefusal('missing-record')
  }
  for (const segment of host.deps.store.conversations.segments(conversationId)) {
    const record = host.deps.store.getRecord(segment.sessionId)
    if (!record || !sameScope(record.location, conversation.location)) {
      throw new ConversationRpcRefusal('scope-mismatch')
    }
    requireStructuredAgentAudience(ctx, record.provider)
  }
  return conversation
}
export async function conversationOperationHost(ctx: RpcContext, operationKey: string) {
  const host = await conversationRpcHost(ctx)
  const intent = host.deps.store.conversations.intent(operationKey)
  if (!intent) {
    throw new ConversationRpcRefusal('missing-record')
  }
  requireConversationRecord(host, ctx, intent.conversationId)
  return { host, intent }
}
