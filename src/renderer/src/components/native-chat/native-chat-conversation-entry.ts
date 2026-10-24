import { prepareConversationNativeRebuild } from './native-chat-conversation-rebuild'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { agentSessionExecutionLocationsEqual } from '../../../../shared/agent-session-record'
import {
  ConversationEnsureSourceSurfaceResultSchema,
  ConversationSurfaceSnapshotSchema,
  ConversationSelectAgentResultSchema,
  type ConversationSurfaceSnapshot,
  type ConversationSelectAgentRequest
} from '../../../../shared/conversation-surface-rpc'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'

import {
  callConversationEntry,
  conversationEntryRpcOptions,
  createConversationEntryLifetime,
  installConversationEntry,
  publishConversationEntry as publish,
  releaseConversationEntry,
  readConversationEntry,
  type ConversationEntryAttempt
} from './native-chat-conversation-entry-state'
export {
  readConversationEntry,
  subscribeConversationEntry,
  forgetConversationEntriesOwnedBy
} from './native-chat-conversation-entry-state'
/** A client request continuation, not switch authority. Survives tab promotion's unmount. */
export function startConversationEntry(
  input: Pick<ConversationEntryAttempt, 'target' | 'tabId' | 'sessionId' | 'agent' | 'workspaceId'>
): Promise<void> {
  if (readConversationEntry(input.target, input.tabId)) {
    return Promise.resolve()
  }
  const attempt: ConversationEntryAttempt = {
    ...input,
    ...createConversationEntryLifetime(input.target),
    kind: 'entry',
    operationId: structuredSessionOperationId(),
    busy: true,
    error: null
  }
  installConversationEntry(attempt)
  return execute(attempt)
}
export function retryConversationEntry(target: RuntimeClientTarget, tabId: string): Promise<void> {
  const prior = readConversationEntry(target, tabId)
  if (!prior || prior.busy || (prior.kind === 'rebuild' && !prior.selection)) {
    return Promise.resolve()
  }
  const attempt = { ...prior, busy: true, error: null }
  publish(attempt)
  return execute(attempt)
}
async function execute(initial: ConversationEntryAttempt): Promise<void> {
  let attempt = initial
  try {
    if (!attempt.conversation) {
      const result: unknown = await callConversationEntry(attempt, 'conversation.ensure', {
        sessionId: attempt.sessionId,
        includeSourceSurface: true
      })
      const enrolled = ConversationEnsureSourceSurfaceResultSchema.safeParse(result)
      if (!enrolled.success) {
        throw new Error('Conversation host does not support canonical source surface identity')
      }
      const { sourceTabId, ...conversation } = enrolled.data
      if (
        conversation.location.workspaceId !== attempt.workspaceId ||
        conversation.location.executionHostId !== 'local'
      ) {
        throw new Error('Conversation enrollment scope changed')
      }
      attempt = { ...attempt, conversation, sourceTabId }
      publish(attempt)
    }
    if (!attempt.selection) {
      const conversation = attempt.conversation
      if (!conversation || !attempt.sourceTabId) {
        throw new Error('Missing conversation enrollment')
      }
      const snapshot = ConversationSurfaceSnapshotSchema.parse(
        await callConversationEntry(attempt, 'conversation.promoteSurface', {
          conversationId: conversation.conversationId,
          sourceSessionId: attempt.sessionId,
          expectedTabId: attempt.sourceTabId,
          expectedRevision: conversation.revision
        })
      )
      if (
        snapshot.conversation.conversationId !== conversation.conversationId ||
        snapshot.surface?.tabId !== attempt.sourceTabId ||
        snapshot.surface.sourceSessionId !== attempt.sessionId ||
        !agentSessionExecutionLocationsEqual(
          snapshot.conversation.location,
          conversation.location
        ) ||
        !agentSessionExecutionLocationsEqual(snapshot.surface.location, conversation.location)
      ) {
        throw new Error('Conversation surface scope changed')
      }
      attempt = {
        ...attempt,
        selection: {
          conversationId: conversation.conversationId,
          expectedRevision: snapshot.conversation.revision,
          expectedContextGeneration: snapshot.conversation.contextGeneration,
          expectedActivationFence: snapshot.conversation.activationFence,
          agent: attempt.agent,
          nativeSession: 'retain-or-create',
          clientOperationId: attempt.operationId
        }
      }
      publish(attempt)
    }
    const result = ConversationSelectAgentResultSchema.parse(
      await callConversationEntry(attempt, 'conversation.selectAgent', attempt.selection)
    )
    if (result.snapshot.conversation.conversationId !== attempt.conversation?.conversationId) {
      throw new Error('Conversation selection scope changed')
    }
    releaseConversationEntry(attempt)
  } catch (error) {
    publish({ ...attempt, busy: false, error })
  }
}

export async function startConversationRebuild(
  target: RuntimeClientTarget,
  tabId: string,
  snapshot: ConversationSurfaceSnapshot
): Promise<void> {
  if (readConversationEntry(target, tabId)) {
    return
  }
  const agent = snapshot.selected?.agent ?? snapshot.active.agent
  if (!isConversationSwitchAgent(agent)) {
    throw new Error('Unsupported native agent')
  }
  let attempt: ConversationEntryAttempt = {
    target,
    tabId,
    workspaceId: snapshot.conversation.location.workspaceId,
    ...createConversationEntryLifetime(target),
    sessionId: snapshot.surface?.sourceSessionId ?? snapshot.active.sessionId,
    agent,
    kind: 'rebuild',
    operationId: structuredSessionOperationId(),
    busy: true,
    error: null,
    conversation: snapshot.conversation
  }
  installConversationEntry(attempt)
  try {
    const selection = await prepareConversationNativeRebuild(
      target,
      snapshot,
      attempt.operationId,
      conversationEntryRpcOptions(attempt)
    )
    attempt = { ...attempt, selection }
    publish(attempt)
    await execute(attempt)
  } catch (error) {
    publish({ ...attempt, busy: false, error })
  }
}
/** Resolve an uncertain cancellation by readback only; never creates another switch. */
export async function refreshConversationEntry(
  target: RuntimeClientTarget,
  tabId: string
): Promise<void> {
  const attempt = readConversationEntry(target, tabId)
  if (!attempt || attempt.busy || !attempt.conversation) {
    return
  }
  try {
    const snapshot = ConversationSurfaceSnapshotSchema.parse(
      await callConversationEntry(attempt, 'conversation.surfaceRead', {
        conversationId: attempt.conversation.conversationId
      })
    )
    if (snapshot.conversation.conversationId !== attempt.conversation.conversationId) {
      throw new Error('Conversation scope changed')
    }
    if (readConversationEntry(target, tabId) !== attempt) {
      return
    }
    releaseConversationEntry(attempt)
  } catch (error) {
    if (readConversationEntry(target, tabId) === attempt) {
      publish({ ...attempt, error })
    }
  }
}

export function isConversationSwitchAgent(
  value: string
): value is ConversationSelectAgentRequest['agent'] {
  return value === 'claude' || value === 'codex' || value === 'opencode'
}
