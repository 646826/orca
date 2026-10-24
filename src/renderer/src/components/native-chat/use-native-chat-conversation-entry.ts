import { useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { translate } from '@/i18n/i18n'
import {
  isConversationSwitchAgent,
  readConversationEntry,
  subscribeConversationEntry,
  startConversationEntry,
  retryConversationEntry,
  refreshConversationEntry
} from './native-chat-conversation-entry'
import { nativeChatConversationRequestFailure } from './native-chat-conversation-notices'
import type { NativeChatAgentSwitchPickerProps } from './NativeChatAgentSwitchPicker'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export function useNativeChatConversationEntryStatus(
  target: RuntimeClientTarget,
  tabId: string,
  expectedConversationId?: string
) {
  const attempt = useSyncExternalStore(subscribeConversationEntry, () =>
    readConversationEntry(target, tabId)
  )
  const scoped =
    attempt &&
    (!expectedConversationId || attempt.conversation?.conversationId === expectedConversationId)
      ? attempt
      : null
  const notices: NativeChatComposerNotice[] = scoped?.error
    ? [
        {
          ...nativeChatConversationRequestFailure(scoped.error),
          ...(scoped.kind === 'entry' || scoped.selection
            ? {
                action: {
                  label: translate(
                    'components.native-chat.agentSwitch.retryEntry',
                    'Retry the same switch request'
                  ),
                  onClick: () => {
                    void retryConversationEntry(target, tabId)
                  },
                  disabled: scoped.busy
                }
              }
            : {
                action: {
                  label: translate(
                    'components.native-chat.agentSwitch.refreshEntry',
                    'Refresh switch state'
                  ),
                  onClick: () => {
                    void refreshConversationEntry(target, tabId)
                  }
                }
              })
        }
      ]
    : []
  return { busy: Boolean(scoped?.busy), pending: Boolean(scoped), notices }
}
export function useNativeChatConversationEntry(input: {
  target: RuntimeClientTarget
  tabId: string
  sessionId: string
  workspaceId: string | null
  agent: AgentType
  enabled: boolean
}) {
  const supported = useStructuredAgentSessionHostCapability(
    input.target,
    NATIVE_CONVERSATION_RUNTIME_CAPABILITY
  )
  const status = useNativeChatConversationEntryStatus(input.target, input.tabId)
  const agentSwitch: NativeChatAgentSwitchPickerProps | undefined =
    input.enabled &&
    input.workspaceId !== null &&
    supported &&
    isConversationSwitchAgent(input.agent)
      ? {
          active: { id: input.agent, label: structuredAgentLabel(input.agent) },
          selected: null,
          busy: status.pending,
          choices: (['claude', 'codex', 'opencode'] as const).map((agent) => ({
            id: agent,
            label: structuredAgentLabel(agent)
          })),
          onSelect: (agent) => {
            if (isConversationSwitchAgent(agent) && input.workspaceId !== null) {
              void startConversationEntry({ ...input, workspaceId: input.workspaceId, agent })
            }
          }
        }
      : undefined
  return { ...status, agentSwitch }
}
