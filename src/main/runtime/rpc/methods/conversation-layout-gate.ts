import type { WindowLayoutCommand } from '../../runtime-layout-apply'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import type { RpcContext } from '../core'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'

/** Only negotiated view changes may touch a surface; lifecycle changes use conversation RPCs. */
export function assertConversationLayoutCommand(
  store: Pick<AgentSessionRecordStore, 'conversations'>,
  command: WindowLayoutCommand,
  supported: boolean
): void {
  const ids =
    command.type === 'renameTabs'
      ? command.renames.map((rename) => rename.tabId)
      : command.type === 'moveTabToWorkspace'
        ? command.tabs.flatMap((tab) => [tab.tabId, tab.newTabId])
        : command.type === 'closeTabs'
          ? command.tabIds
          : 'tabId' in command && command.tabId
            ? [command.tabId]
            : []
  for (const tabId of ids) {
    const surface = store.conversations.surfaces.readByTab(tabId)
    if (!surface) {
      continue
    }
    if (
      !supported ||
      !surface.visible ||
      !['renameTab', 'renameTabs', 'moveTab', 'splitGroup', 'setTabProps'].includes(command.type)
    ) {
      throw new ConversationRpcRefusal('unsupported')
    }
    const workspace =
      command.type === 'renameTabs'
        ? command.renames.find((rename) => rename.tabId === tabId)?.workspace
        : command.workspace
    if (workspace !== surface.location.workspaceId) {
      throw new ConversationRpcRefusal('unsupported')
    }
  }
}

export async function conversationLayoutAdmission(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>,
  command: WindowLayoutCommand
): Promise<() => void> {
  const store = await context.runtime.openAgentSessionRecordStore()
  const supported =
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(NATIVE_CONVERSATION_RUNTIME_CAPABILITY) === true
  const check = () => assertConversationLayoutCommand(store, command, supported)
  check()
  return check
}
