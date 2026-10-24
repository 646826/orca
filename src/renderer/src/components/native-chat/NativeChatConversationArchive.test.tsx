import type { captureConversationReaderOwner } from '@/runtime/conversation-reader-owner'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatConversationArchive } from './NativeChatConversationArchive'
import { entrySnapshot } from './native-chat-conversation-entry.test-fixture'
vi.mock('@/i18n/i18n', () => ({ translate: (_id: string, text: string) => text }))
afterEach(cleanup)
const snapshot = {
  ...entrySnapshot,
  operation: null,
  conversation: { ...entrySnapshot.conversation, contextGeneration: 2, pendingOperationKey: null }
}
it('checks durable archive status and requires a separate explicit delete action', async () => {
  const request = vi
    .fn<ReturnType<typeof captureConversationReaderOwner>['request']>()
    .mockResolvedValue(null)
  const screen = render(
    <NativeChatConversationArchive
      snapshot={snapshot}
      busy={false}
      request={request}
      run={async (action) => action()}
    />
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete archive' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Delete archive' }))
  expect(request.mock.calls.map(([method]) => method)).toEqual(['conversation.archiveStatus'])
  fireEvent.click(screen.getByRole('button', { name: 'Delete this archived context' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      'conversation.deleteArchive',
      expect.objectContaining({ contextGeneration: 1, expectedRevision: 3 })
    )
  )
})
it('resumes the durable cleanup job after remount without submitting another delete', async () => {
  const request = vi
    .fn<ReturnType<typeof captureConversationReaderOwner>['request']>()
    .mockResolvedValue({ operationKey: 'persisted-delete', phase: 'cleanup' })
  const screen = render(
    <NativeChatConversationArchive
      snapshot={snapshot}
      busy={false}
      request={request}
      run={async (action) => action()}
    />
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continue archive cleanup' })).toBeTruthy()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Continue archive cleanup' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('conversation.cleanupArchive', {
      conversationId: 'c',
      operationKey: 'persisted-delete'
    })
  )
  expect(request.mock.calls.some(([method]) => method === 'conversation.deleteArchive')).toBe(false)
})
