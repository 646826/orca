import { vi } from 'vitest'
import type { MobileConversationClient } from './mobile-conversation-reader'
import type { ConversationSurfaceSnapshot } from '../../../src/shared/conversation-surface-rpc'
import type { ConnectionState } from '../transport/types'
export function mobileConversationFixture() {
  const location = {
    executionHostId: 'local' as const,
    workspaceId: 'w',
    workspaceKind: 'folder' as const,
    wslDistro: null
  }
  const display = {
    sessionId: 'a',
    agent: 'claude',
    agentLabel: 'Claude',
    profile: { state: 'unknown' as const },
    authenticatedAccount: { state: 'unknown' as const },
    host: { id: 'local', label: 'Host' },
    workspace: { id: 'w', label: 'Folder', kind: 'folder' as const, wslDistro: null },
    permissions: { selected: null, applied: null, state: 'unverified' as const },
    startupTrust: 'unobserved' as const,
    transport: 'unverified' as const
  }
  const snapshot: ConversationSurfaceSnapshot = {
    conversation: {
      conversationId: 'c',
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'a',
      pendingOperationKey: null,
      location
    },
    active: display,
    selected: { ...display, sessionId: 'b', agent: 'codex', agentLabel: 'Codex' },
    operation: null,
    surface: null
  }
  let generation = 1,
    event: (value: unknown) => void = () => {}
  const listeners = new Set<(state: ConnectionState) => void>()
  const send = vi.fn<MobileConversationClient['sendRequest']>(async (method) => {
    const result =
      method === 'conversation.surfaceRead'
        ? snapshot
        : method === 'conversation.read'
          ? { conversation: snapshot.conversation, segments: [], nextSegmentOrdinal: null }
          : {}
    return { id: 'reply', ok: true, result }
  })
  const client: MobileConversationClient = {
    sendRequest: send,
    getGeneration: () => generation,
    subscribe: (_method, _params, callback) => {
      event = callback
      return () => {}
    },
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  return {
    client,
    send,
    snapshot,
    event: (value: unknown) => event(value),
    replace: () => {
      generation++
      for (const listener of listeners) {
        listener('connected')
      }
    }
  }
}
