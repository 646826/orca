import { expect, test, vi } from 'vitest'
import { watchConversationChanges } from './conversation-watch'

test('coalesces authoritative changes and cancels every polling timer', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let revision = 1
  const read = vi.fn(() => ({
    token: String(revision),
    state: {
      conversationId: 'c',
      revision,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'a',
      pendingOperationKey: null,
      surfaceRevision: 1,
      historyInvalidated: true
    }
  }))
  const emit = vi.fn()
  const run = watchConversationChanges({ signal: controller.signal, read, emit })
  expect(emit).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(emit).toHaveBeenCalledTimes(1)
  revision++
  await vi.advanceTimersByTimeAsync(1000)
  expect(emit).toHaveBeenCalledTimes(2)
  controller.abort()
  await run
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})
