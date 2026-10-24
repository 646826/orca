import { expect, it, vi } from 'vitest'
import { createConversationReaderState } from './native-chat-conversation-reader'
import type { RuntimeConversationReader } from '@/runtime/runtime-conversation-reader'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'

function fixture() {
  const controller = new AbortController()
  const display = {
    sessionId: 'active',
    agent: 'codex',
    agentLabel: 'Codex',
    profile: { state: 'unknown' as const },
    authenticatedAccount: { state: 'unknown' as const },
    host: { id: 'local', label: 'Local' },
    workspace: { id: 'w', label: 'Workspace', kind: 'folder' as const, wslDistro: null },
    permissions: { selected: null, applied: null, state: 'unverified' as const },
    startupTrust: 'unobserved' as const,
    transport: 'unverified' as const
  }
  const parsed: ConversationSurfaceSnapshot = {
    conversation: {
      conversationId: 'c',
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'a',
      pendingOperationKey: 'switch',
      location: {
        executionHostId: 'local',
        workspaceId: 'w',
        workspaceKind: 'folder',
        wslDistro: null
      }
    },
    active: display,
    selected: { ...display, sessionId: 'candidate', agent: 'claude' },
    operation: null,
    surface: null
  }
  let invalidate = () => {}
  const close = vi.fn()
  const port: RuntimeConversationReader = {
    snapshot: vi.fn(async () => parsed),
    segments: vi.fn(async () => ({
      conversation: parsed.conversation,
      segments: [
        {
          segmentId: 'a',
          conversationId: 'c',
          ordinal: 1,
          sessionId: 'active',
          contextGeneration: 1,
          activationFence: 1,
          nativeBindingGeneration: 1,
          startSequence: 1,
          boundary: { sessionId: 'active', epoch: 'e', endSequence: 2 },
          sourceRevision: 'r'
        }
      ],
      nextSegmentOrdinal: null
    })),
    history: vi.fn(async () => ({
      segmentId: 'a',
      sourceRevision: 'r',
      readOnly: true as const,
      items: [],
      next: null,
      status: 'complete' as const
    })),
    watch: vi.fn(async (change) => {
      invalidate = change
      return close
    }),
    reconnect: () => () => {}
  }
  return { port, controller, close, invalidate: () => invalidate() }
}
it('uses host active identity while target is merely selected and reads bounded tail pages', async () => {
  const f = fixture(),
    reader = createConversationReaderState(f.port)
  await reader.start()
  expect(reader.getSnapshot().surface?.active.sessionId).toBe('active')
  expect(reader.getSnapshot().surface?.selected?.sessionId).toBe('candidate')
  expect(f.port.history).toHaveBeenCalledWith('a', 'r', null, expect.any(AbortSignal))
  expect(reader.getSnapshot().readCurrent).toBe(true)
  reader.close()
  expect(f.close).toHaveBeenCalledOnce()
})
it('does not publish a snapshot returned after disposal', async () => {
  const f = fixture()
  let resolve!: (value: ConversationSurfaceSnapshot) => void
  const normal = await f.port.snapshot(f.controller.signal)
  f.port.snapshot = () =>
    new Promise((done) => {
      resolve = done
    })
  const reader = createConversationReaderState(f.port),
    started = reader.start()
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  reader.close()
  resolve(normal)
  await started
  expect(reader.getSnapshot().surface).toBeNull()
})

it('coalesces repeated invalidations and never calls a selected target an active owner', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    reader = createConversationReaderState(f.port)
  try {
    await reader.start()
    f.invalidate()
    f.invalidate()
    f.invalidate()
    expect(reader.getSnapshot().readCurrent).toBe(false)
    expect(f.port.snapshot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.port.snapshot).toHaveBeenCalledTimes(2)
    expect(reader.getSnapshot().surface?.active.sessionId).toBe('active')
  } finally {
    reader.close()
    vi.useRealTimers()
  }
})

it('serializes a refresh behind an admitted older-page read instead of mixing source generations', async () => {
  const f = fixture(),
    reader = createConversationReaderState(f.port)
  const cursor = { epochOrdinal: 1, sequence: 2, index: 0, ordinal: 1 }
  f.port.history = vi.fn(async () => ({
    segmentId: 'a',
    sourceRevision: 'r',
    readOnly: true as const,
    items: [],
    next: cursor,
    status: 'more' as const
  }))
  await reader.start()
  let finish!: (value: Awaited<ReturnType<RuntimeConversationReader['history']>>) => void
  f.port.history = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const older = reader.loadEarlier()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  void reader.refresh()
  expect(f.port.snapshot).toHaveBeenCalledTimes(1)
  reader.close()
  finish({
    segmentId: 'a',
    sourceRevision: 'r',
    readOnly: true as const,
    items: [],
    next: null,
    status: 'complete' as const
  })
  await older
})

it('closes an obsolete watch that resolves after a reconnect replacement', async () => {
  const f = fixture()
  let reconnect = () => {}
  f.port.reconnect = (callback) => {
    reconnect = callback
    return () => {}
  }
  let first!: (close: () => void) => void
  const obsoleteClose = vi.fn(),
    replacementClose = vi.fn()
  let watches = 0
  f.port.watch = () =>
    ++watches === 1
      ? new Promise((resolve) => {
          first = resolve
        })
      : Promise.resolve(replacementClose)
  const reader = createConversationReaderState(f.port),
    starting = reader.start()
  reconnect()
  await Promise.resolve()
  first(obsoleteClose)
  await starting
  expect(obsoleteClose).toHaveBeenCalledOnce()
  expect(replacementClose).not.toHaveBeenCalled()
  reader.close()
  expect(replacementClose).toHaveBeenCalledOnce()
})

function row(
  segmentId: string,
  sequence: number
): Awaited<ReturnType<RuntimeConversationReader['history']>>['items'][number] {
  return {
    segmentId,
    provider: 'codex',
    originSource: { sessionId: segmentId, epoch: 'e', sequence },
    revisionEpoch: 'e',
    item: {
      itemId: String(sequence),
      revision: 1,
      sequence,
      observedAt: 0,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: String(sequence) }] }
    }
  }
}
it('retains manually expanded segment history beyond the initial sixteen descriptors on refresh', async () => {
  const f = fixture()
  const template = await f.port.segments(null, f.controller.signal)
  const base = template.segments[0]
  const descriptors = Array.from({ length: 17 }, (_, index) => ({
    ...base,
    segmentId: String(17 - index),
    sessionId: String(17 - index),
    ordinal: 17 - index
  }))
  f.port.segments = vi.fn(async (before) => ({
    ...template,
    segments: descriptors.filter((entry) => before === null || entry.ordinal < before).slice(0, 16),
    nextSegmentOrdinal: before === null ? 2 : null
  }))
  f.port.history = vi.fn(async (segmentId) => ({
    segmentId,
    sourceRevision: 'r',
    readOnly: true as const,
    items: [row(segmentId, 1)],
    next: null,
    status: 'complete' as const
  }))
  const reader = createConversationReaderState(f.port)
  await reader.start()
  for (let index = 0; index < 16; index++) {
    await reader.loadEarlier()
  }
  expect(reader.getSnapshot().rows).toHaveLength(17)
  vi.mocked(f.port.segments).mockClear()
  await reader.refresh()
  expect(reader.getSnapshot().rows).toHaveLength(17)
  expect(f.port.segments).toHaveBeenCalledTimes(2)
  reader.close()
})
it.each([false, true])(
  'retains expanded active pages and rereads changed evidence: changed=%s',
  async (changed) => {
    const f = fixture()
    const template = await f.port.segments(null, f.controller.signal)
    let revision = 'r'
    const cursor = { epochOrdinal: 1, sequence: 2, index: 0, ordinal: 1 }
    f.port.segments = async () => ({
      ...template,
      segments: template.segments.map((segment) => ({ ...segment, sourceRevision: revision }))
    })
    f.port.history = vi.fn(async (segmentId, sourceRevision, after) => ({
      segmentId,
      sourceRevision,
      readOnly: true as const,
      items: [row(segmentId, after ? 1 : 2)],
      next: after ? null : cursor,
      status: after ? ('complete' as const) : ('more' as const)
    }))
    const reader = createConversationReaderState(f.port)
    await reader.start()
    await reader.loadEarlier()
    revision = changed ? 'changed' : 'r'
    vi.mocked(f.port.history).mockClear()
    await reader.refresh()
    expect(reader.getSnapshot().rows.map((entry) => entry.item.itemId)).toEqual(['1', '2'])
    expect(f.port.history).toHaveBeenCalledTimes(changed ? 2 : 0)
    expect(vi.mocked(f.port.history).mock.calls.every((call) => call[1] === revision)).toBe(true)
    reader.close()
  }
)

it('retains the last authorized page when refreshed segment metadata races a generation change', async () => {
  const f = fixture()
  f.port.history = async () => ({
    segmentId: 'a',
    sourceRevision: 'r',
    readOnly: true,
    items: [row('a', 1)],
    next: null,
    status: 'complete'
  })
  const reader = createConversationReaderState(f.port)
  await reader.start()
  const page = await f.port.segments(null, f.controller.signal)
  f.port.segments = async () => ({
    ...page,
    conversation: { ...page.conversation, contextGeneration: 2 }
  })
  await reader.refresh()
  expect(reader.getSnapshot()).toMatchObject({ readCurrent: false, error: true })
  expect(reader.getSnapshot().rows).toHaveLength(1)
  reader.close()
})
it('does not publish an expanded replacement that finishes after cancellation', async () => {
  const f = fixture()
  const descriptorPage = await f.port.segments(null, f.controller.signal)
  f.port.history = async () => ({
    segmentId: 'a',
    sourceRevision: 'r',
    readOnly: true,
    items: [row('a', 1)],
    next: null,
    status: 'complete'
  })
  const reader = createConversationReaderState(f.port)
  await reader.start()
  f.port.segments = async () => ({
    ...descriptorPage,
    segments: descriptorPage.segments.map((entry) => ({ ...entry, sourceRevision: 'new' }))
  })
  let finish!: (page: Awaited<ReturnType<RuntimeConversationReader['history']>>) => void
  f.port.history = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const refreshing = reader.refresh()
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  reader.close()
  finish({
    segmentId: 'a',
    sourceRevision: 'new',
    readOnly: true,
    items: [row('a', 2)],
    next: null,
    status: 'complete'
  })
  await refreshing
  expect(reader.getSnapshot().rows[0].item.itemId).toBe('1')
})

it('preserves the oldest expanded source identity when new tail pages arrive', async () => {
  const f = fixture(),
    template = await f.port.segments(null, f.controller.signal)
  let latest = 2
  f.port.segments = async () => ({
    ...template,
    segments: template.segments.map((segment) => ({ ...segment, sourceRevision: `r${latest}` }))
  })
  f.port.history = async (segmentId, sourceRevision, after) => {
    const sequence = after ? after.sequence - 1 : latest
    return {
      segmentId,
      sourceRevision,
      readOnly: true,
      items: [row(segmentId, sequence)],
      next: sequence > 1 ? { epochOrdinal: 1, sequence, index: 0, ordinal: sequence } : null,
      status: sequence > 1 ? 'more' : 'complete'
    }
  }
  const reader = createConversationReaderState(f.port)
  await reader.start()
  await reader.loadEarlier()
  latest = 4
  await reader.refresh()
  expect(reader.getSnapshot().rows.map((entry) => entry.item.itemId)).toEqual(['1', '2', '3', '4'])
  reader.close()
})
it('keeps the unseen middle segment range reachable after a large activation jump', async () => {
  const f = fixture(),
    template = await f.port.segments(null, f.controller.signal)
  let latest = 50
  f.port.segments = vi.fn(async (before) => {
    const end = before === null ? latest : before - 1
    const segments = Array.from({ length: Math.min(end, 16) }, (_, index) => ({
      ...template.segments[0],
      segmentId: String(end - index),
      sessionId: String(end - index),
      ordinal: end - index
    }))
    return { ...template, segments, nextSegmentOrdinal: end > 16 ? end - 15 : null }
  })
  f.port.history = async (segmentId) => ({
    segmentId,
    sourceRevision: 'r',
    readOnly: true,
    items: [row(segmentId, 1)],
    next: null,
    status: 'complete'
  })
  const reader = createConversationReaderState(f.port)
  await reader.start()
  latest = 100
  await reader.refresh()
  for (let index = 0; index < 17; index++) {
    await reader.loadEarlier()
  }
  expect(reader.getSnapshot().rows.some((entry) => entry.segmentId === '84')).toBe(true)
  expect(f.port.segments).toHaveBeenCalledWith(85, expect.any(AbortSignal))
  reader.close()
})

it('retains the old expanded view on bounded refresh overflow until explicit latest-view reset', async () => {
  const f = fixture(),
    template = await f.port.segments(null, f.controller.signal)
  let latest = 2
  f.port.segments = async () => ({
    ...template,
    segments: template.segments.map((segment) => ({ ...segment, sourceRevision: `r${latest}` }))
  })
  f.port.history = vi.fn(async (segmentId, sourceRevision, after) => {
    const sequence = after ? after.sequence - 1 : latest
    return {
      segmentId,
      sourceRevision,
      readOnly: true as const,
      items: [row(segmentId, sequence)],
      next: sequence > 1 ? { epochOrdinal: 1, sequence, index: 0, ordinal: sequence } : null,
      status: sequence > 1 ? ('more' as const) : ('complete' as const)
    }
  })
  const reader = createConversationReaderState(f.port)
  await reader.start()
  await reader.loadEarlier()
  latest = 40
  vi.mocked(f.port.history).mockClear()
  await reader.refresh()
  expect(reader.getSnapshot()).toMatchObject({
    resourceLimited: true,
    readCurrent: false,
    error: true
  })
  expect(reader.getSnapshot().rows.map((entry) => entry.item.itemId)).toEqual(['1', '2'])
  expect(f.port.history).toHaveBeenCalledTimes(10)
  reader.resetHistory()
  await vi.waitFor(() => expect(reader.getSnapshot().readCurrent).toBe(true))
  expect(reader.getSnapshot().rows.map((entry) => entry.item.itemId)).toEqual(['40'])
  reader.close()
})
it('clears the active owner and historical display immediately when its pairing is retired', async () => {
  const f = fixture()
  let retire: (() => void) | undefined
  f.port.watch = async (_change, _unavailable, ownerChanged) => {
    retire = ownerChanged
    return f.close
  }
  const reader = createConversationReaderState(f.port)
  await reader.start()
  expect(reader.getSnapshot().surface?.active.sessionId).toBe('active')
  retire?.()
  expect(reader.getSnapshot()).toMatchObject({
    surface: null,
    rows: [],
    readCurrent: false,
    error: true,
    hasMore: false
  })
  reader.close()
})

it('evicts cached archive immediately on an authoritative deletion revision even if fresh history fails', async () => {
  const f = fixture()
  const original = await f.port.snapshot(f.controller.signal)
  let archiveRevision = 0
  f.port.snapshot = async () => ({ ...original, archiveRevision })
  f.port.history = vi.fn(async () => ({
    segmentId: 'a',
    sourceRevision: 'r',
    readOnly: true as const,
    items: [row('a', 1)],
    next: null,
    status: 'complete' as const
  }))
  const reader = createConversationReaderState(f.port)
  await reader.start()
  expect(reader.getSnapshot().rows).toHaveLength(1)
  archiveRevision = 3
  f.port.segments = async () => {
    throw new Error('temporary read failure after deletion')
  }
  await reader.refresh()
  expect(reader.getSnapshot()).toMatchObject({
    rows: [],
    hasMore: false,
    readCurrent: false,
    error: true
  })
  reader.close()
})
