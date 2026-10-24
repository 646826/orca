import { expect, it, vi } from 'vitest'
import type { ConversationSurfaceSnapshot } from '../../../shared/conversation-surface-rpc'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
import { setConversationTabVisibility } from './conversation-tab-visibility'
const ref = {
  conversationId: 'c',
  tabId: 'tab',
  workspaceId: 'w',
  target: { kind: 'local' as const }
}
function snapshot(visible: boolean, revision = 1): ConversationSurfaceSnapshot {
  const location = {
    executionHostId: 'local' as const,
    workspaceId: 'w',
    workspaceKind: 'folder' as const,
    wslDistro: null
  }
  return {
    conversation: {
      conversationId: 'c',
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'a',
      pendingOperationKey: null,
      location
    },
    active: {
      sessionId: 'a',
      agent: 'codex',
      agentLabel: 'Codex',
      profile: { state: 'unknown' },
      authenticatedAccount: { state: 'unknown' },
      host: { id: 'local', label: 'Local' },
      workspace: { id: 'w', label: 'w', kind: 'folder', wslDistro: null },
      permissions: { selected: null, applied: null, state: 'unverified' },
      startupTrust: 'unobserved',
      transport: 'unverified'
    },
    selected: null,
    operation: null,
    surface: {
      conversationId: 'c',
      sourceSessionId: 'a',
      tabId: 'tab',
      location,
      visible,
      surfaceRevision: revision,
      publishedRevision: revision
    }
  }
}
it('closes and reopens the same aggregate through fresh surface CAS without native retirement', async () => {
  let current = snapshot(true)
  rpc.mockImplementation(async (_target, method, params) => {
    if (method === 'conversation.surfaceRead') {
      return current
    }
    expect(method).toBe('conversation.setSurfaceVisibility')
    expect(params.expectedSurfaceRevision).toBe(current.surface?.surfaceRevision)
    current = snapshot(params.visible, (current.surface?.surfaceRevision ?? 0) + 1)
    return current
  })
  await setConversationTabVisibility(ref, false)
  expect(current.surface?.visible).toBe(false)
  await setConversationTabVisibility(ref, true)
  expect(current.surface).toMatchObject({ visible: true, tabId: 'tab', conversationId: 'c' })
})
it('reconciles a lost close reply from durable visibility without replaying another close', async () => {
  rpc
    .mockReset()
    .mockResolvedValueOnce(snapshot(true))
    .mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce(snapshot(false, 2))
  await expect(setConversationTabVisibility(ref, false)).resolves.toMatchObject({
    surface: { visible: false }
  })
  expect(
    rpc.mock.calls.filter((call) => call[1] === 'conversation.setSurfaceVisibility')
  ).toHaveLength(1)
})
it('does not claim a close when its uncertain reply cannot be reconciled', async () => {
  rpc
    .mockReset()
    .mockResolvedValueOnce(snapshot(true))
    .mockRejectedValueOnce(new Error('reply lost'))
    .mockResolvedValueOnce(snapshot(true))
  await expect(setConversationTabVisibility(ref, false)).rejects.toThrow()
  expect(
    rpc.mock.calls.filter((call) => call[1] === 'conversation.setSurfaceVisibility')
  ).toHaveLength(1)
})
it('refuses a different host-owned surface before visibility mutation', async () => {
  const wrong = snapshot(true)
  if (wrong.surface) {
    wrong.surface.tabId = 'other'
  }
  rpc.mockReset().mockResolvedValue(wrong)
  await expect(setConversationTabVisibility(ref, false)).rejects.toThrow()
  expect(rpc).toHaveBeenCalledTimes(1)
})
it('refuses an unstamped remote reopen instead of adopting the current pairing', async () => {
  rpc.mockClear()
  await expect(
    setConversationTabVisibility(
      { ...ref, target: { kind: 'environment', environmentId: 'paired' } },
      true
    )
  ).rejects.toThrow('pairing unavailable')
  expect(rpc).not.toHaveBeenCalled()
})
it('does not acknowledge visibility before its authoritative layout publication', async () => {
  const unpublished = snapshot(false, 2)
  if (unpublished.surface) {
    unpublished.surface.publishedRevision = 1
  }
  rpc.mockReset().mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(unpublished)
  await expect(setConversationTabVisibility(ref, false)).rejects.toThrow(
    'publication is incomplete'
  )
})

it.each(['surface-host', 'conversation-host', 'surface-workspace', 'conversation-workspace'])(
  'refuses a remote response with a mismatched %s before visibility mutation',
  async (mismatch) => {
    const wrong = snapshot(true)
    if (mismatch === 'surface-host' && wrong.surface) {
      wrong.surface = {
        ...wrong.surface,
        location: { ...wrong.surface.location, executionHostId: 'runtime:foreign' }
      }
    } else if (mismatch === 'conversation-host') {
      wrong.conversation = {
        ...wrong.conversation,
        location: { ...wrong.conversation.location, executionHostId: 'runtime:foreign' }
      }
    } else if (mismatch === 'surface-workspace' && wrong.surface) {
      wrong.surface = {
        ...wrong.surface,
        location: { ...wrong.surface.location, workspaceId: 'foreign' }
      }
    } else if (mismatch === 'conversation-workspace') {
      wrong.conversation = {
        ...wrong.conversation,
        location: { ...wrong.conversation.location, workspaceId: 'foreign' }
      }
    }
    rpc.mockReset().mockResolvedValue(wrong)
    await expect(
      setConversationTabVisibility(
        { ...ref, target: { kind: 'environment', environmentId: 'paired' }, pairingRevision: 10 },
        false
      )
    ).rejects.toThrow('surface owner changed')
    expect(rpc.mock.calls.map((call) => call[1])).toEqual(['conversation.surfaceRead'])
  }
)
