import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { useEffect, useMemo, useState, useCallback, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createRuntimeConversationReader } from '@/runtime/runtime-conversation-reader'
import { createConversationReaderState } from './native-chat-conversation-reader'
import { projectConversationHistory } from './native-chat-conversation-history'
import { useTranslation } from 'react-i18next'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

export function useNativeChatConversation(
  conversationId: string,
  target: RuntimeClientTarget,
  enabled: boolean
) {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const createReader = useCallback(
    () =>
      createConversationReaderState(
        createRuntimeConversationReader(
          environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
          conversationId
        )
      ),
    [conversationId, environmentId]
  )
  const [selection, setSelection] = useState(() => ({
    factory: createReader,
    reader: createReader()
  }))
  const reader = selection.reader
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot)
  // A route change must not render the previous host's owner before the effect runs.
  const state =
    selection.factory === createReader
      ? snapshot
      : { ...snapshot, surface: null, rows: [], loading: true, readCurrent: false }

  const { t } = useTranslation()
  useEffect(() => {
    // Each effect lifetime owns its reader, including React StrictMode's setup replay.
    const next = createReader()
    setSelection({ factory: createReader, reader: next })
    if (enabled) {
      void next.start()
    }
    return next.close
  }, [enabled, createReader])
  const messages = useMemo(
    () =>
      projectConversationHistory(state.rows, (entry) =>
        t(
          'components.native-chat.agentSwitch.segmentAttribution',
          '{{agent}} · conversation segment',
          { agent: entry.provider }
        )
      ),
    [state.rows, t]
  )
  const display: NativeChatLiveSession = {
    sessionId: conversationId,
    agent: state.surface?.active.agent ?? 'claude',
    messages,
    status: state.loading ? 'loading' : messages.length ? 'ready' : state.error ? 'error' : 'empty',
    hasMore: state.hasMore,
    loadingEarlier: state.loadingOlder,
    olderHistoryGeneration: state.generation,
    loadEarlier: reader.loadEarlier,
    readPhase: state.loading ? 'loading' : state.error ? 'error' : 'ready',
    readCurrent: state.readCurrent
  }
  const historyNotice: NativeChatComposerNotice | undefined = state.error
    ? {
        key: 'conversation-history-refresh',
        kind: 'host',
        tone: 'warning',
        text: state.resourceLimited
          ? t(
              'components.native-chat.agentSwitch.historyWindowLimit',
              'The expanded history could not be refreshed within the read limit. The previous view is retained. Loading the latest history resets only this expanded view.'
            )
          : t(
              'components.native-chat.agentSwitch.historyRefreshFailed',
              'History could not be refreshed. The previous view may be out of date.'
            ),
        action: {
          label: state.resourceLimited
            ? t('components.native-chat.agentSwitch.loadLatestHistory', 'Load latest history')
            : t('components.native-chat.agentSwitch.retryRead', 'Retry'),
          onClick: () => {
            if (state.resourceLimited) {
              reader.resetHistory()
            } else {
              void reader.refresh()
            }
          }
        }
      }
    : undefined
  return { ...state, display, historyNotice, refresh: reader.refresh }
}
