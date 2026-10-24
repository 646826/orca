import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createConversationReaderState } from '../../../src/shared/conversation-read-state'
import { projectConversationHistory } from '../../../src/shared/conversation-read-projection'
import {
  createMobileConversationReader,
  type MobileConversationClient
} from './mobile-conversation-reader'

export function useMobileConversation(
  client: MobileConversationClient,
  hostId: string,
  workspaceId: string,
  conversationId: string
) {
  const subscribeGeneration = useCallback(
    (changed: () => void) => client.onStateChange(changed),
    [client]
  )
  const readGeneration = useCallback(() => client.getGeneration?.(), [client])
  const generation = useSyncExternalStore(subscribeGeneration, readGeneration)
  const owner = useMemo(
    () => ({ client, hostId, workspaceId, conversationId, generation }),
    [client, hostId, workspaceId, conversationId, generation]
  )
  const factory = useCallback(
    () =>
      createConversationReaderState(
        createMobileConversationReader(
          owner.client,
          owner.conversationId,
          owner.workspaceId,
          owner.generation
        )
      ),
    [owner]
  )
  const [selection, setSelection] = useState(() => ({ factory, reader: factory() }))
  const snapshot = useSyncExternalStore(selection.reader.subscribe, selection.reader.getSnapshot)
  const state =
    selection.factory === factory
      ? snapshot
      : { ...snapshot, surface: null, rows: [], readCurrent: false, loading: true }
  useEffect(() => {
    const reader = factory()
    setSelection({ factory, reader })
    void reader.start()
    return reader.close
  }, [factory])
  const messages = useMemo(
    () =>
      projectConversationHistory(state.rows, (row) => `${row.provider} · conversation segment`).map(
        (message) => ({
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'image-ref'
              ? { type: 'text' as const, text: 'Historical attachment unavailable on mobile.' }
              : block
          )
        })
      ),
    [state.rows]
  )
  return {
    ...state,
    messages,
    refresh: selection.reader.refresh,
    loadEarlier: selection.reader.loadEarlier,
    resetHistory: selection.reader.resetHistory
  }
}
