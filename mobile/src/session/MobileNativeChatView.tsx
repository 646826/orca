import type { MobileNativeChatViewProps } from './mobile-native-chat-view-props'
export type { MobileNativeChatInputLockReason } from './mobile-native-chat-view-props'
import { useCallback, useMemo } from 'react'
import { nativeChatTaskListPredecessors } from '../../../src/shared/native-chat-task-list-history'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './mobile-native-chat-disclosure-store'
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Text,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import { mobileNativeChatListFooter } from './mobile-native-chat-list-footer'
import { mobileNativeChatListHeader } from './mobile-native-chat-list-header'
import {
  buildMobileNativeChatTransientData,
  mobileNativeChatEmptyState
} from './mobile-native-chat-render-data'
import { useMobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { useMobileNativeChatPinchGesture } from './use-mobile-native-chat-pinch-gesture'
import { useMobileNativeChatTailFollow } from './use-mobile-native-chat-tail-follow'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'
import {
  mobileNativeChatComposerPlaceholder,
  useSettledMobileNativeChatInputLock
} from './use-mobile-native-chat-input-lease'
import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'
import { MobileNativeChatFloatingControls } from './MobileNativeChatFloatingControls'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { MobileNativeChatPromptCard } from './MobileNativeChatPromptCard'
import { NO_COMPOSER_TRAY } from './use-mobile-native-chat-composer-tray'
import { MobileNativeChatScrollRootsBoundary } from './MobileNativeChatScrollRootsBoundary'
import { MobileNativeChatRowList } from './MobileNativeChatRowList'
import { useMobileNativeChatRowRenderer } from './use-mobile-native-chat-row-renderer'

export function MobileNativeChatView({
  readOnly,
  messages,
  folded,
  status,
  error,
  readFailedFinally = false,
  agent,
  agentWorking,
  canStop = agentWorking,
  structuredActivityUi = false,
  turnIndicator = null,
  workingStartedAt,
  settledTurns,
  turnJournal = null,
  receipts = null,
  actionablePromptIds,
  onStop,
  streaming,
  hasMore,
  olderPages = 'idle',
  onLoadEarlier,
  onSend,
  sendSurfaceId,
  getSendCompletionGeneration,
  getComposerEditGeneration,
  pending,
  imagePreviewsByMessageId,
  composerText,
  onComposerTextChange,
  onAttachImage,
  attachments,
  onRemoveAttachment,
  isAttaching,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  sendErrorMessage,
  onClearSendError,
  filePaths,
  onNeedFiles,
  sessionOptions,
  structuredComposer = null,
  ask,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  askRequiresTerminal = false,
  onAnswerInTerminal,
  onCancelAsk,
  onCancelPrompt,
  onCollapseAsk,
  onCollapsePrompt,
  collapsedPrompt,
  question,
  onAnswerQuestion,
  permission,
  promptKey,
  onRespondPermission,
  composerTray: { content: trayContent, composerInputRef: inputRef } = NO_COMPOSER_TRAY,
  onOpenFile,
  keyboardInset = 0
}: MobileNativeChatViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  // Lift the composer clear of the keyboard, plus the bottom safe-area so it
  // never sits under the home indicator / nav bar (mirrors the terminal dock).
  const bottomPad = keyboardInset > 0 ? keyboardInset + insets.bottom : insets.bottom
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  // `data` is the list source: folded transcript + synthetic streaming bubble +
  // route-owned accepted echoes. Memoize on the same deps so the
  // downstream autoscroll effects/`renderItem` keep referential stability.
  const { data } = useMemo(
    () =>
      buildMobileNativeChatTransientData({
        messages,
        folded,
        streaming,
        pending,
        imagePreviewsByMessageId
      }),
    [messages, folded, streaming, pending, imagePreviewsByMessageId]
  )
  const tail = useMobileNativeChatTailFollow({ hasItems: data.length > 0, scopeKey: sendSurfaceId })
  const { jumpToTail, recordScrollMetrics, scrollMayLoadEarlier } = tail

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      if (readOnly || !onSend) {
        return false
      }
      const accepted = await onSend(text)
      if (!accepted) {
        return false
      }
      // The route-owned banner outlives this send; a success must retire it too,
      // or a stale "Message not sent" sits above the delivered message.
      onClearSendError?.()
      // Always jump to the newest message when the user sends.
      jumpToTail()
      return true
    },
    [readOnly, onSend, onClearSendError, jumpToTail]
  )

  const loadEarlier = useCallback(() => onLoadEarlier?.(), [onLoadEarlier])
  // After a failure only a tap retries, so a reader still at the top can't loop the spinner.
  const loadEarlierNearTop = hasMore && olderPages === 'idle' ? loadEarlier : undefined

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      recordScrollMetrics(e.nativeEvent)
      // Near the top of a native list — page in older history. Only the reader's drag: a pin reports
      // offsets too. The page's list asks for itself.
      if (contentOffset.y < 60 && scrollMayLoadEarlier()) {
        loadEarlierNearTop?.()
      }
    },
    [loadEarlierNearTop, scrollMayLoadEarlier, recordScrollMetrics]
  )

  // Per-turn status rows: one live indicator while the turn runs, then a settled
  // "Worked for N" row. The structured lane owns them; the bridge lane gets the live line only.
  const turns = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: structuredActivityUi,
    isWorking: agentWorking === true,
    workingStartedAt,
    settledTurns,
    turnJournal,
    thinking: turnIndicator?.thinking === true,
    activityText: turnIndicator?.activityText ?? null,
    // The display status, decided once in the session hook.
    stopping: turnIndicator?.stopping === true,
    lineYields: ask != null || permission != null || question != null,
    receipts,
    scopeKey: sendSurfaceId
  })

  // What the reader opened in this chat's runs, kept above the rows the list recycles or windows out.
  const rowKeys = useMobileNativeChatRowKeys(folded, messages, sendSurfaceId, turns.presentation)
  const disclosures = useMobileNativeChatDisclosures(sendSurfaceId)
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(data), [data])
  const renderItem = useMobileNativeChatRowRenderer({
    rowKeyOf: rowKeys.keyOf,
    runOwners: rowKeys.runOwners,
    taskListPredecessors,
    fontScale,
    onOpenFile,
    structuredActivityUi,
    turns,
    turnJournal,
    agent,
    receipts,
    actionablePromptIds: readOnly ? [] : actionablePromptIds
  })

  const liveStatus = turns.liveLine ? (
    <MobileNativeChatLiveLine
      line={turns.liveLine}
      onToggleReasoning={turns.onToggleReasoning}
      fontScale={fontScale}
      onOpenFile={onOpenFile}
    />
  ) : null

  const header = mobileNativeChatListHeader(hasMore, olderPages, loadEarlier)
  // How rows draw: a change re-lays every row, and the page keeps the reader's line through it.
  const layoutKey = `${fontScale}`
  const footer = mobileNativeChatListFooter(liveStatus, turns.waitingRows, renderItem)
  const emptyState = mobileNativeChatEmptyState(status, agent ?? null, error)

  const lockReason = useSettledMobileNativeChatInputLock(inputLockReason)
  const composerPlaceholder = mobileNativeChatComposerPlaceholder(
    lockReason,
    turnIndicator?.afterStop
  )
  // Why only Send, terminal-backed only: that send types into the agent's prompt and can answer it,
  // while drafting never does; the host queues a structured send behind it.
  const expandedPromptOwnsSend =
    !structuredActivityUi && !collapsedPrompt && (ask ?? permission ?? question) != null
  const emptyStateView = emptyState ? (
    <View style={styles.center}>
      <Text style={styles.emptyTitle}>{emptyState.title}</Text>
      <Text style={styles.emptySubtitle}>{emptyState.subtitle}</Text>
    </View>
  ) : null

  // Whatever was already on screen: nothing here can act on a chat that cannot load, and its words
  // say why once, as a fresh open's do.
  if (readFailedFinally && emptyStateView) {
    return <View style={[styles.root, { paddingBottom: bottomPad }]}>{emptyStateView}</View>
  }

  return (
    <View style={[styles.root, { paddingBottom: bottomPad }]}>
      {status === 'loading' && messages.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : (
        <GestureHandlerRootView style={styles.listWrap}>
          <MobileNativeChatDisclosureContext.Provider value={disclosures}>
            <MobileNativeChatScrollRootsBoundary
              {...{ rowKeys, layoutKey }}
              roots={disclosures.roots}
              runPlacements={rowKeys.runPlacements}
            >
              <GestureDetector gesture={pinchGesture}>
                <MobileNativeChatRowList
                  {...{ tail, rowKeys, renderItem, footer, emptyStateView, onScroll, layoutKey }}
                  {...{ header, hasHeader: hasMore === true, onNearTop: loadEarlierNearTop }}
                  rows={turns.listMessages}
                  runs={turns.presentation.workRuns.heads}
                  roots={disclosures.roots}
                  contentContainerStyle={styles.listContent}
                />
              </GestureDetector>
            </MobileNativeChatScrollRootsBoundary>
          </MobileNativeChatDisclosureContext.Provider>
          <MobileNativeChatFloatingControls
            showJumpToTail={tail.showJumpToTail}
            onJumpToTail={jumpToTail}
          />
        </GestureHandlerRootView>
      )}
      {!readOnly && (
        <>
          <MobileNativeChatPromptCard
            key={promptKey ?? undefined}
            {...{
              ask,
              askKey,
              onDismissAsk,
              onAnswerAsk,
              onCancelAsk,
              onCancelPrompt,
              onCollapseAsk
            }}
            requiresTerminal={askRequiresTerminal}
            onAnswerInTerminal={onAnswerInTerminal}
            {...{ permission, onRespondPermission, question, onAnswerQuestion, onCollapsePrompt }}
            collapsedPrompt={collapsedPrompt}
          />
          <Text
            style={lockReason === 'waiting' ? styles.inputLockStatus : undefined}
            accessibilityLiveRegion="polite"
          >
            {lockReason === 'waiting' ? composerPlaceholder : null}
          </Text>
          {sendErrorMessage ? (
            // This banner is the only channel for a send failure — announce it.
            <View
              style={styles.sendError}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              <Text style={styles.sendErrorText}>{sendErrorMessage}</Text>
            </View>
          ) : null}
          {/* Directly on the composer, which it tucks into. */}
          {trayContent}
          <MobileNativeChatComposer
            structured={structuredActivityUi ? structuredComposer : null}
            value={composerText}
            onChangeText={onComposerTextChange}
            onSend={handleSend}
            sendSurfaceId={sendSurfaceId}
            {...{ getSendCompletionGeneration, getComposerEditGeneration, inputRef }}
            agent={agent}
            sessionOptions={sessionOptions}
            onAttachImage={onAttachImage}
            attachments={attachments}
            onRemoveAttachment={onRemoveAttachment}
            isAttaching={isAttaching}
            onMicPress={onMicPress}
            micActive={micActive}
            dictationMode={dictationMode}
            onMicPressIn={onMicPressIn}
            onMicPressOut={onMicPressOut}
            disabled={lockReason !== null}
            sendDisabled={expandedPromptOwnsSend}
            placeholder={composerPlaceholder}
            filePaths={filePaths}
            onNeedFiles={onNeedFiles}
            stop={
              canStop
                ? {
                    onStop,
                    held: agentWorking === true && turnIndicator?.stopRequestInFlight === true
                  }
                : null
            }
          />
        </>
      )}
    </View>
  )
}
