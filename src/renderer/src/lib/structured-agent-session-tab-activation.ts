import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionFocusOwner,
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/structured-agent-session-owner'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { Tab } from '../../../shared/tab-types'

export function findStructuredAgentSessionTab(
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  args: { workspaceId: string; sessionId: string; target?: RuntimeClientTarget }
): Tab | null {
  return (
    unifiedTabsByWorktree[args.workspaceId]?.find(
      (candidate) =>
        candidate.worktreeId === args.workspaceId &&
        candidate.contentType === 'agent-session' &&
        candidate.entityId === args.sessionId &&
        (!args.target ||
          structuredAgentSessionOwnerForTab(useAppStore.getState(), candidate) ===
            executionHostIdForStructuredTarget(args.target))
    ) ?? null
  )
}

export function activateStructuredAgentSessionTab(args: {
  worktreeId: string
  tabId: string
  target?: RuntimeClientTarget
}): boolean {
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate): candidate is Tab & { contentType: 'agent-session' | 'conversation' } =>
      candidate.id === args.tabId &&
      (candidate.contentType === 'agent-session' || candidate.contentType === 'conversation') &&
      (!args.target ||
        structuredAgentSessionOwnerForTab(state, candidate) ===
          executionHostIdForStructuredTarget(args.target))
  )
  if (!tab) {
    return false
  }
  const conversationTarget =
    tab.contentType === 'conversation'
      ? (args.target ?? structuredAgentSessionTargetForTab(state, tab))
      : null
  if (tab.contentType === 'conversation' && !conversationTarget) {
    return false
  }
  state.focusGroup(args.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: args.worktreeId })
  state.setActiveTabType(tab.contentType, args.worktreeId)
  requestNativeChatComposerFocus(tab.id)
  if (conversationTarget) {
    // Conversation inventory ids are durable host surface ids, unlike native session wire ids.
    const hostTabId = resolveHostSessionTabIdForWebSessionTab(state, {
      ...structuredAgentSessionFocusOwner(conversationTarget),
      worktreeId: args.worktreeId,
      tabId: tab.id
    })
    // Activation has no conversation-id CAS. A local alias could name an unrelated host tab.
    if (!hostTabId) {
      return true
    }
    void callRuntimeRpc(conversationTarget, 'session.tabs.activate', {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: hostTabId,
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    }).catch((error: unknown) => {
      console.warn('[native-chat] synchronizing conversation tab selection failed', error)
    })
    return true
  }
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, args.worktreeId)
  void callRuntimeRpc(
    args.target ?? runtimeTargetForOwnerEnvironment(environmentId),
    'session.tabs.activate',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: `agent-session:${tab.entityId}`
    }
  )
  return true
}

export function activateStructuredAgentSessionById(args: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
}): boolean {
  const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
    workspaceId: args.worktreeId,
    sessionId: args.sessionId,
    target: args.target
  })
  return tab
    ? activateStructuredAgentSessionTab({
        worktreeId: args.worktreeId,
        tabId: tab.id,
        target: args.target
      })
    : false
}
