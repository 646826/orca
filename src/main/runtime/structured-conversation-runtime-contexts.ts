import { scheduleNativeChatVisualsSweep } from '../native-chat/native-chat-visuals-sweep'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { StructuredAgentSessionHostDeps } from '../native-chat/agent-session-wire/structured-agent-session-host-types'
import { bindAtRestCommandContexts } from '../native-chat/agent-session-wire/at-rest-command-context'
import type { StructuredAgentSessionAtRestCommands } from '../native-chat/agent-session-wire/structured-agent-session-at-rest-commands'
import type { ConversationDeliveryHost } from '../native-chat/conversations/conversation-delivery-plan'
import type { OpenedAgentSessionRecordStore } from './agent-session-record-store-slot'

/** Command and delivery services belong to one installed host, including failed installation. */
export function bindRuntimeContexts(
  registrations: readonly { adapter: { atRestCommands?: StructuredAgentSessionAtRestCommands } }[],
  opened: Pick<OpenedAgentSessionRecordStore, 'journalDatabase' | 'conversationDeliveryBinding'>,
  deliveryHost: ConversationDeliveryHost | undefined
): () => void {
  const stopCommands = bindAtRestCommandContexts(
    registrations.map(({ adapter }) => adapter.atRestCommands)
  )
  let stopDelivery: (() => void) | undefined
  try {
    stopDelivery = deliveryHost
      ? opened.conversationDeliveryBinding.install(opened.journalDatabase, deliveryHost)
      : undefined
  } catch (error) {
    stopCommands()
    throw error
  }
  return () => {
    stopDelivery?.()
    stopCommands()
  }
}

export function startRuntimeBackgroundWork(input: {
  deps: Pick<StructuredAgentSessionRuntimeDeps, 'nativeChatVisuals' | 'stateDirectory' | 'logger'>
  opened: Pick<
    OpenedAgentSessionRecordStore,
    'journalDatabase' | 'conversationDeliveryBinding' | 'store'
  >
  registrations: Parameters<typeof bindRuntimeContexts>[0]
  deliveryHost: ConversationDeliveryHost | undefined
  modelCatalog: StructuredAgentSessionHostDeps['modelCatalog']
}): () => void {
  const stopContexts = bindRuntimeContexts(input.registrations, input.opened, input.deliveryHost)
  let stopVisuals: (() => void) | undefined
  try {
    stopVisuals = input.deps.nativeChatVisuals
      ? scheduleNativeChatVisualsSweep({
          stateDirectory: input.deps.stateDirectory,
          listHeldSessionIds: () =>
            input.opened.store.readOnly ? null : input.opened.store.listHeldSessionIds(),
          logger: input.deps.logger
        })
      : undefined
  } catch (error) {
    stopContexts()
    throw error
  }
  return () => {
    stopContexts()
    stopVisuals?.()
    input.modelCatalog?.stop()
  }
}
