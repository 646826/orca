import { mobileConversationFixture as fixture } from './mobile-conversation.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  createMobileConversationReader,
  type MobileConversationClient
} from './mobile-conversation-reader'
import { createConversationReaderState } from '../../../src/shared/conversation-read-state'
it('uses committed active identity while selected target is pending without opening any native session', async () => {
  const f = fixture(),
    reader = createConversationReaderState(createMobileConversationReader(f.client, 'c', 'w'))
  await reader.start()
  expect(reader.getSnapshot().surface?.active.sessionId).toBe('a')
  expect(reader.getSnapshot().surface?.selected?.sessionId).toBe('b')
  expect(f.send.mock.calls.map(([method]) => method)).toEqual([
    'conversation.surfaceRead',
    'conversation.read'
  ])
  f.replace()
  expect(reader.getSnapshot()).toMatchObject({ surface: null, rows: [], readCurrent: false })
  reader.close()
})
it('rejects late history from a replaced logical client and does not read the new owner', async () => {
  const f = fixture(),
    reader = createMobileConversationReader(f.client, 'c', 'w')
  let done!: (value: Awaited<ReturnType<MobileConversationClient['sendRequest']>>) => void
  f.send.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve
      })
  )
  const pending = reader.history('s', 'r', null, new AbortController().signal)
  f.replace()
  done({
    id: 'reply',
    ok: true,
    result: {
      segmentId: 's',
      sourceRevision: 'r',
      readOnly: true,
      items: [],
      next: null,
      status: 'complete'
    }
  })
  await expect(pending).rejects.toThrow('owner changed')
  f.send.mockClear()
  await expect(reader.snapshot(new AbortController().signal)).rejects.toThrow('owner changed')
  expect(f.send).not.toHaveBeenCalled()
})
it('refuses foreign history identity and explicitly unwatches delayed ready after close', async () => {
  const f = fixture(),
    reader = createMobileConversationReader(f.client, 'c', 'w')
  f.send.mockResolvedValue({
    id: 'reply',
    ok: true,
    result: {
      segmentId: 'foreign',
      sourceRevision: 'r',
      readOnly: true,
      items: [],
      next: null,
      status: 'complete'
    }
  })
  await expect(reader.history('s', 'r', null, new AbortController().signal)).rejects.toThrow(
    'unavailable'
  )
  const close = await reader.watch(vi.fn(), vi.fn())
  close()
  f.event({
    type: 'ready',
    subscriptionId: 'late',
    state: {
      conversationId: 'c',
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'a',
      pendingOperationKey: null,
      surfaceRevision: 1,
      historyInvalidated: false
    }
  })
  expect(f.send).toHaveBeenLastCalledWith(
    'conversation.unwatch',
    { subscriptionId: 'late' },
    expect.anything()
  )
})
