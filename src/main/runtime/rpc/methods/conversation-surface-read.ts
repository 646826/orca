import {
  NATIVE_CONVERSATION_RUNTIME_CAPABILITY,
  NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY
} from '../../../../shared/conversation-runtime-capabilities'
import { readConversationTransferIntentions } from '../../../native-chat/conversations/conversation-transfer-recovery-view'
import { ConversationClearViewSchema } from '../../../../shared/conversation-clear-record'
import {
  ConversationSurfaceSnapshotSchema,
  type ConversationAgentDisplay
} from '../../../../shared/conversation-surface-rpc'
import { isStructuredAgentId } from '../../../../shared/agent-session-provider-handle'
import { isAgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { requireConversationRecord } from './conversation-method-access'
import { conversationOperationView, boundedConversationResult } from './conversation-public-result'

export function conversationAgentDisplay(
  host: StructuredAgentSessionHost,
  sessionId: string
): ConversationAgentDisplay {
  const record = host.deps.store.getRecord(sessionId)
  if (!record || !isStructuredAgentId(record.provider)) {
    throw new ConversationRpcRefusal('target-unavailable')
  }
  const label: unknown = Object.getOwnPropertyDescriptor(
    TUI_AGENT_DISPLAY_NAMES,
    record.provider
  )?.value
  const capabilities = host.deps.adapter.contextDeliveryCapabilities?.(sessionId, record.provider)
  const selected = isAgentChatPermissionMode(record.permissionMode) ? record.permissionMode : null
  return {
    sessionId,
    agent: record.provider,
    agentLabel: typeof label === 'string' ? label : record.provider,
    profile: { state: 'unknown' },
    authenticatedAccount: { state: 'unknown' },
    host: { id: record.location.executionHostId, label: record.location.executionHostId },
    workspace: {
      id: record.location.workspaceId,
      label: record.location.workspaceId,
      kind: record.location.workspaceKind,
      wslDistro: record.location.wslDistro
    },
    permissions: { selected, applied: null, state: 'unverified' },
    startupTrust:
      capabilities?.state === 'verified' && capabilities.startupTrust === 'approved'
        ? 'approved'
        : 'unobserved',
    transport:
      capabilities?.state !== 'verified'
        ? 'unverified'
        : capabilities.passiveImport !== 'unsupported'
          ? 'passive'
          : capabilities.firstTurnReceipt !== 'unsupported'
            ? 'first-user-turn'
            : 'unverified'
  }
}
export function readConversationSurface(
  host: StructuredAgentSessionHost,
  ctx: RpcContext,
  conversationId: string
) {
  const conversation = requireConversationRecord(host, ctx, conversationId)
  const active = host.deps.store.conversations
    .segments(conversationId)
    .find((s) => s.segmentId === conversation.activeSegmentId)
  if (!active) {
    throw new ConversationRpcRefusal('source-unavailable')
  }
  const intent = conversation.pendingOperationKey
    ? host.deps.store.conversations.intent(conversation.pendingOperationKey)
    : null
  const clear = conversation.pendingOperationKey
    ? host.deps.store.conversations.clear.intent(conversation.pendingOperationKey)
    : null
  return boundedConversationResult(
    ConversationSurfaceSnapshotSchema.parse({
      conversation,
      ...(ctx.clientKind === undefined ||
      ctx.clientCapabilities?.includes(NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY)
        ? {
            transferRecovery: readConversationTransferIntentions({
              db: host.deps.journalDatabase.db,
              stateDirectory: host.deps.journalDatabase.stateDirectory,
              currentRuntimeFence: (proof) =>
                ctx.clientKind === undefined ||
                (ctx.clientKind !== 'mobile' &&
                  ctx.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY))
                  ? host.deps.store.conversations.currentTransferRecoveryFence(proof)
                  : null,
              conversationId
            })
          }
        : {}),
      active: conversationAgentDisplay(host, active.sessionId),
      selected: intent ? conversationAgentDisplay(host, intent.targetSessionId) : null,
      operation: intent ? conversationOperationView(intent) : null,
      clear: clear ? ConversationClearViewSchema.parse(clear) : null,
      archiveRevision: host.deps.store.conversations.archive.revision(conversationId),
      surface: host.deps.store.conversations.surfaces.read(conversationId)
    })
  )
}
