import { NativeChatConversationClear } from './NativeChatConversationClear'
import { NativeChatConversationCandidatePrompts } from './NativeChatConversationCandidatePrompts'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { startConversationRebuild } from './native-chat-conversation-entry'
import { useNativeChatConversationEntryStatus } from './use-native-chat-conversation-entry'
import { useEffect } from 'react'
import {
  conversationDraftScopeKey,
  registerConversationDraftOwner
} from './native-chat-conversation-draft'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatConversation } from './use-native-chat-conversation'
import { useNativeChatConversationControls } from './use-native-chat-conversation-controls'
import { NativeChatConversationControlsPanel } from './NativeChatConversationControlsPanel'
import { NativeChatLoadingCue } from './NativeChatLoadingCue'
import NativeChatView from './NativeChatView'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

type Props = Omit<NativeChatStructuredViewProps, 'mode' | 'sessionId' | 'agent'> & {
  conversationId: string
}
export function NativeChatConversation(props: Props) {
  const state = useNativeChatConversation(props.conversationId, props.target, props.isVisible)
  if (!state.surface || !state.surface.surface) {
    return state.error ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        {translate(
          'components.native-chat.agentSwitch.readUnavailable',
          'Conversation history is unavailable. Reconnect or retry to read its current owner.'
        )}
        <Button variant="outline" onClick={() => void state.refresh()}>
          {translate('components.native-chat.agentSwitch.retryRead', 'Retry')}
        </Button>
      </div>
    ) : (
      <NativeChatLoadingCue />
    )
  }
  return (
    <LoadedConversation
      {...props}
      snapshot={state.surface}
      display={state.display}
      historyNotice={state.historyNotice}
      onRefresh={state.refresh}
    />
  )
}
function LoadedConversation(
  props: Props & {
    snapshot: ConversationSurfaceSnapshot
    display: NativeChatLiveSession
    historyNotice?: NativeChatComposerNotice
    onRefresh: () => Promise<void>
  }
) {
  const { snapshot } = props
  const entry = useNativeChatConversationEntryStatus(
    props.target,
    props.tabId,
    props.conversationId
  )
  const nativeControls = useNativeChatConversationControls({
    snapshot,
    target: props.target,
    onRefresh: props.onRefresh
  })
  const controls = {
    ...nativeControls,
    busy: nativeControls.busy || entry.pending,
    agentSwitch: {
      ...nativeControls.agentSwitch,
      busy: nativeControls.agentSwitch.busy || entry.pending
    }
  }
  useEffect(
    () => (snapshot.surface ? registerConversationDraftOwner(snapshot.surface) : undefined),
    [snapshot.surface]
  )
  const candidate =
    snapshot.operation &&
    snapshot.selected &&
    snapshot.operation.operationKey === snapshot.conversation.pendingOperationKey &&
    snapshot.operation.contextGeneration === snapshot.conversation.contextGeneration &&
    snapshot.operation.targetSessionId === snapshot.selected.sessionId &&
    snapshot.operation.phase !== 'activated' &&
    snapshot.operation.phase !== 'cancelled' &&
    snapshot.selected.sessionId !== snapshot.active.sessionId
      ? snapshot.selected
      : null
  const founder = snapshot.surface
  if (!founder) {
    return <NativeChatLoadingCue />
  }
  return (
    <NativeChatView
      mode="structured"
      tabId={props.tabId}
      groupId={props.groupId}
      target={props.target}
      sessionId={snapshot.active.sessionId}
      agent={snapshot.active.agent}
      isVisible={props.isVisible}
      isFocusedGroup={props.isFocusedGroup}
      contextMenuActions={props.contextMenuActions}
      conversationView={{
        conversationId: props.conversationId,
        contextGeneration: snapshot.conversation.contextGeneration,
        composerScopeKey: conversationDraftScopeKey(founder),
        display: props.display,
        agentSwitch: controls.agentSwitch,
        notices: [
          ...controls.notices,
          ...entry.notices,
          ...(props.historyNotice ? [props.historyNotice] : [])
        ],
        controls: (
          <>
            <NativeChatConversationClear
              snapshot={snapshot}
              target={props.target}
              onRefresh={props.onRefresh}
            />
            <NativeChatConversationControlsPanel
              snapshot={snapshot}
              controls={controls}
              onRebuild={() => {
                void startConversationRebuild(props.target, props.tabId, snapshot)
              }}
            />
            {candidate && snapshot.operation ? (
              <NativeChatConversationCandidatePrompts
                key={`${snapshot.operation.operationKey}:${candidate.sessionId}`}
                sessionId={candidate.sessionId}
                target={props.target}
                agentLabel={candidate.agentLabel}
                isVisible={props.isVisible}
              />
            ) : null}
          </>
        )
      }}
    />
  )
}
