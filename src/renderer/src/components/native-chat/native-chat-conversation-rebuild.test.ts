import { expect, it, vi } from 'vitest'
import { prepareConversationNativeRebuild } from './native-chat-conversation-rebuild'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
import { entrySnapshot } from './native-chat-conversation-entry.test-fixture'

const snapshot = {
  ...entrySnapshot,
  selected: { ...entrySnapshot.active, sessionId: 'b', agent: 'codex' as const }
}
it('never cancels or replays a possibly dispatched operation', async () => {
  rpc.mockReset()
  await expect(
    prepareConversationNativeRebuild(
      { kind: 'local' },
      { ...snapshot, operation: { ...snapshot.operation, phase: 'delivering' } },
      'operation'
    )
  ).rejects.toThrow()
  expect(rpc).not.toHaveBeenCalled()
})
it('an uncertain cancellation never starts a new operation', async () => {
  rpc.mockReset().mockRejectedValueOnce(new Error('response lost'))
  await expect(
    prepareConversationNativeRebuild({ kind: 'local' }, snapshot, 'operation')
  ).rejects.toThrow('response lost')
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0][1]).toBe('conversation.cancel')
})
it('a racing pending operation after cancellation blocks rebuild', async () => {
  rpc
    .mockReset()
    .mockResolvedValueOnce({ ...snapshot.operation, phase: 'cancelled' })
    .mockResolvedValueOnce(snapshot)
  await expect(
    prepareConversationNativeRebuild({ kind: 'local' }, snapshot, 'operation')
  ).rejects.toThrow()
  expect(rpc.mock.calls.map((call) => call[1])).toEqual([
    'conversation.cancel',
    'conversation.surfaceRead'
  ])
})
