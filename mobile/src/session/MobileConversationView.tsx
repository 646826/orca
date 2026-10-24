import { View, Text, Pressable } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RuntimeMobileSessionConversationTab } from '../../../src/shared/conversation-inventory'
import { MobileNativeChatView } from './MobileNativeChatView'
import { useMobileConversation } from './use-mobile-conversation'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import { MobileNativeChatVisualContext } from './mobile-native-chat-visual-context'
import { styles } from './mobile-native-chat-view-styles'

export function MobileConversationView(props: {
  client: RpcClient | null
  hostId: string
  workspaceId: string
  tab: RuntimeMobileSessionConversationTab
}) {
  if (!props.client) {
    return <Text style={styles.emptySubtitle}>Conversation unavailable while disconnected.</Text>
  }
  return <ConnectedConversation {...props} client={props.client} />
}
function ConnectedConversation({
  client,
  hostId,
  workspaceId,
  tab
}: {
  client: RpcClient
  hostId: string
  workspaceId: string
  tab: RuntimeMobileSessionConversationTab
}) {
  const state = useMobileConversation(client, hostId, workspaceId, tab.conversationId)
  return (
    <View style={styles.root}>
      <Text style={styles.emptySubtitle}>
        {state.surface
          ? `Active agent: ${state.surface.active.agentLabel}`
          : `Last reported agent: ${tab.activeAgent}`}
      </Text>
      {state.surface?.selected && (
        <Text style={styles.emptySubtitle}>
          Switch pending: {state.surface.selected.agentLabel}
        </Text>
      )}
      <Text style={styles.emptySubtitle}>
        Read-only on mobile. Use Orca desktop to send messages, switch agents, or manage this
        conversation.
      </Text>
      <Text style={styles.emptySubtitle}>
        Historical attachments and full-output retrieval are unavailable in this mobile view.
      </Text>
      {state.error && (
        <View accessibilityRole="alert">
          <Text style={styles.sendErrorText}>
            Conversation history could not be refreshed. The retained view may be out of date.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => (state.resourceLimited ? state.resetHistory() : void state.refresh())}
          >
            <Text style={styles.emptySubtitle}>
              {state.resourceLimited ? 'Load latest history' : 'Retry history'}
            </Text>
          </Pressable>
        </View>
      )}
      <MobileNativeChatItemSourceContext.Provider value={null}>
        <MobileNativeChatVisualContext.Provider value={null}>
          <MobileNativeChatView
            readOnly
            messages={state.messages}
            folded={state.messages}
            status={
              state.loading ? 'loading' : state.error && !state.messages.length ? 'error' : 'ready'
            }
            error={state.error ? 'Conversation history unavailable' : undefined}
            streaming={null}
            pending={[]}
            agent={state.surface?.active.agent ?? tab.activeAgent}
            sendSurfaceId={JSON.stringify([
              hostId,
              workspaceId,
              tab.conversationId,
              state.surface?.conversation.contextGeneration ?? tab.contextGeneration
            ])}
            hasMore={state.hasMore}
            olderPages={state.loadingOlder ? 'loading' : state.error ? 'failed' : 'idle'}
            onLoadEarlier={() => {
              void state.loadEarlier()
            }}
          />
        </MobileNativeChatVisualContext.Provider>
      </MobileNativeChatItemSourceContext.Provider>
    </View>
  )
}
