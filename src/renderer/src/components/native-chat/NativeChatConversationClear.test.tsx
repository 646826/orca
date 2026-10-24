// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatConversationClear } from './NativeChatConversationClear'
import { entrySnapshot } from './native-chat-conversation-entry.test-fixture'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/conversation-reader-owner', () => ({
  captureConversationReaderOwner: () => ({
    request: rpc,
    current: () => true,
    subscribe: () => () => {}
  })
}))
afterEach(cleanup)
vi.mock('@/i18n/i18n', () => ({ translate: (_id: string, text: string) => text }))
it('requires the clear disclosure action before sending an aggregate request, never a native command', async () => {
  const snapshot = {
    ...entrySnapshot,
    operation: null,
    conversation: { ...entrySnapshot.conversation, pendingOperationKey: null }
  }
  rpc.mockResolvedValue({
    decision: 'admit',
    intent: {
      operationKey: 'clear-op',
      conversationId: snapshot.conversation.conversationId,
      version: 1,
      contextGeneration: 1,
      activationFence: 1,
      phase: 'quiescing',
      preserveArchive: true
    }
  })
  const screen = render(
    <NativeChatConversationClear
      snapshot={snapshot}
      target={{ kind: 'local' }}
      onRefresh={async () => {}}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Clear context' }))
  expect(rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Clear all agents and keep archive' }))
  await waitFor(() => expect(rpc).toHaveBeenCalled())
  expect(rpc.mock.calls[0]?.[0]).toBe('conversation.clear')
  expect(rpc.mock.calls.some(([method]) => method === 'agentSession.conversationCommand')).toBe(
    false
  )
})

it.each(['generation', 'owner'] as const)(
  'retires an old clear request when the %s changes without freezing new controls',
  async (change) => {
    rpc.mockReset()
    const response = Promise.withResolvers<unknown>()
    rpc.mockReturnValue(response.promise)
    const refresh = vi.fn(async () => {})
    const snapshot = {
      ...entrySnapshot,
      operation: null,
      conversation: { ...entrySnapshot.conversation, pendingOperationKey: null },
      clear: {
        operationKey: 'old-clear',
        conversationId: 'c',
        version: 1,
        contextGeneration: 1,
        activationFence: 2,
        phase: 'quiescing' as const,
        preserveArchive: true as const
      }
    }
    const screen = render(
      <NativeChatConversationClear
        snapshot={snapshot}
        target={{ kind: 'local' }}
        onRefresh={refresh}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continue context clear' }))
    screen.rerender(
      <NativeChatConversationClear
        snapshot={{
          ...snapshot,
          clear: null,
          conversation: {
            ...snapshot.conversation,
            contextGeneration: change === 'generation' ? 2 : 1
          }
        }}
        target={
          change === 'owner'
            ? { kind: 'environment', environmentId: 'replacement' }
            : { kind: 'local' }
        }
        onRefresh={refresh}
      />
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear context' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    await act(async () => {
      response.resolve({ kind: 'committed' })
      await response.promise
    })
    await waitFor(() =>
      expect(
        rpc.mock.calls.filter(([method]) => method === 'conversation.clearAdvance')
      ).toHaveLength(1)
    )
    expect(refresh).not.toHaveBeenCalled()
  }
)
