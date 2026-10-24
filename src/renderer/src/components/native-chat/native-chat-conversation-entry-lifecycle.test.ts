import { beforeEach, expect, it, vi } from 'vitest'
import { NATIVE_CONVERSATION_RUNTIME_CAPABILITY } from '../../../../shared/conversation-runtime-capabilities'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  startConversationEntry,
  readConversationEntry,
  retryConversationEntry,
  forgetConversationEntriesOwnedBy
} from './native-chat-conversation-entry'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { deleteWorkspaceChatDrafts } from '../../store/slices/worktrees/teardown/removed-worktree-chat-drafts'
import { entrySnapshot } from './native-chat-conversation-entry.test-fixture'
const { rpc, supportsCapability } = vi.hoisted(() => ({
  rpc: vi.fn(),
  supportsCapability: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  runtimeEnvironmentSupportsCapability: supportsCapability
}))
beforeEach(() => {
  rpc.mockReset()
  supportsCapability.mockReset().mockResolvedValue(true)
  setLocalRuntimeCapabilitiesForTests([NATIVE_CONVERSATION_RUNTIME_CAPABILITY])
})

it('does not enroll on an unsupported paired host, including retry', async () => {
  const target = { kind: 'environment', environmentId: 'old-entry-env' } as const
  replaceRuntimeEnvironmentRevisions([
    { id: target.environmentId, createdAt: 1, pairingRevision: 9 }
  ])
  supportsCapability.mockResolvedValue(false)
  await startConversationEntry({
    target,
    tabId: 'old-host',
    sessionId: 'a',
    agent: 'codex',
    workspaceId: 'w'
  })
  await retryConversationEntry(target, 'old-host')
  expect(supportsCapability).toHaveBeenCalledTimes(2)
  expect(supportsCapability).toHaveBeenCalledWith(
    target.environmentId,
    NATIVE_CONVERSATION_RUNTIME_CAPABILITY
  )
  expect(rpc).not.toHaveBeenCalled()
  expect(readConversationEntry(target, 'old-host')).toMatchObject({
    busy: false,
    error: { reason: 'unsupported' }
  })
  replaceRuntimeEnvironmentRevisions([])
})

it('retires a pending capability probe before it can enroll on a replacement pairing', async () => {
  const target = { kind: 'environment', environmentId: 'probing-entry-env' } as const
  replaceRuntimeEnvironmentRevisions([
    { id: target.environmentId, createdAt: 1, pairingRevision: 9 }
  ])
  let resolve!: (value: boolean) => void
  supportsCapability.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done
      })
  )
  const pending = startConversationEntry({
    target,
    tabId: 'probing',
    sessionId: 'a',
    agent: 'codex',
    workspaceId: 'w'
  })
  expect(supportsCapability).toHaveBeenCalledOnce()
  replaceRuntimeEnvironmentRevisions(
    [{ id: target.environmentId, createdAt: 1, pairingRevision: 10 }],
    { retired: [target.environmentId], sameHost: [] }
  )
  resolve(true)
  await pending
  expect(rpc).not.toHaveBeenCalled()
  expect(readConversationEntry(target, 'probing')).toBeNull()
  replaceRuntimeEnvironmentRevisions([])
})

it('refuses an unproven pairing change before probing retry capabilities', async () => {
  const target = { kind: 'environment', environmentId: 'unproven-entry-env' } as const
  replaceRuntimeEnvironmentRevisions([
    { id: target.environmentId, createdAt: 1, pairingRevision: 9 }
  ])
  supportsCapability.mockResolvedValue(false)
  await startConversationEntry({
    target,
    tabId: 'unproven',
    sessionId: 'a',
    agent: 'codex',
    workspaceId: 'w'
  })
  replaceRuntimeEnvironmentRevisions([
    { id: target.environmentId, createdAt: 1, pairingRevision: 10 }
  ])
  await retryConversationEntry(target, 'unproven')
  expect(supportsCapability).toHaveBeenCalledOnce()
  expect(rpc).not.toHaveBeenCalled()
  expect(readConversationEntry(target, 'unproven')?.error).toMatchObject({
    message: 'Runtime host pairing changed during conversation entry'
  })
  replaceRuntimeEnvironmentRevisions([])
})
it('confirmed scope removal stops a late enrollment reply from promoting or repopulating the cache', async () => {
  const target = { kind: 'local' } as const
  let resolve!: (value: unknown) => void
  rpc.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const pending = startConversationEntry({
    target,
    tabId: 'removed',
    sessionId: 'a',
    agent: 'codex',
    workspaceId: 'w'
  })
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  forgetConversationEntriesOwnedBy({ workspaceId: 'w', executionHostId: 'runtime:other' })
  expect(readConversationEntry(target, 'removed')).not.toBeNull()
  deleteWorkspaceChatDrafts({
    owners: [{ workspaceId: 'w', executionHostId: 'local' }],
    conversations: [],
    terminalTabIds: []
  })
  resolve(entrySnapshot.conversation)
  await pending
  expect(readConversationEntry(target, 'removed')).toBeNull()
  expect(rpc).toHaveBeenCalledTimes(1)
})
it('captures one pairing for every stage and retry, and retires attempts before replacement host use', async () => {
  rpc.mockReset()
  replaceRuntimeEnvironmentRevisions([{ id: 'entry-env', createdAt: 1, pairingRevision: 10 }])
  const target = { kind: 'environment', environmentId: 'entry-env' } as const
  const location = {
    ...entrySnapshot.conversation.location,
    executionHostId: 'local' as const
  }
  const snapshot = {
    ...entrySnapshot,
    conversation: { ...entrySnapshot.conversation, location, pendingOperationKey: null },
    operation: null,
    surface: {
      conversationId: 'c',
      tabId: 'remote',
      sourceSessionId: 'a',
      location,
      surfaceRevision: 1,
      publishedRevision: 1,
      visible: true
    }
  }
  rpc.mockImplementation(async (_target, method) =>
    method === 'conversation.ensure'
      ? { ...snapshot.conversation, sourceTabId: 'remote' }
      : method === 'conversation.promoteSurface'
        ? snapshot
        : Promise.reject(new Error('lost reply'))
  )
  await startConversationEntry({
    target,
    tabId: 'remote',
    sessionId: 'a',
    agent: 'codex',
    workspaceId: 'w'
  })
  await retryConversationEntry(target, 'remote')
  for (const call of rpc.mock.calls) {
    expect(call[3]).toMatchObject({
      expectedEnvironmentPairingRevision: 10,
      signal: expect.any(AbortSignal),
      beforeSend: expect.any(Function)
    })
  }
  const oldBeforeSend = rpc.mock.calls[2][3].beforeSend
  replaceRuntimeEnvironmentRevisions([{ id: 'entry-env', createdAt: 1, pairingRevision: 20 }], {
    retired: ['entry-env'],
    sameHost: []
  })
  expect(() => oldBeforeSend()).toThrow()
  expect(readConversationEntry(target, 'remote')).toBeNull()
  await retryConversationEntry(target, 'remote')
  expect(rpc).toHaveBeenCalledTimes(4)
  replaceRuntimeEnvironmentRevisions([])
})
it('never captures a later pairing when the initial host identity was unavailable', async () => {
  rpc.mockReset()
  const target = { kind: 'environment', environmentId: 'unpaired-entry' } as const
  await startConversationEntry({
    target,
    tabId: 'unpaired',
    sessionId: 'a',
    agent: 'codex',
    workspaceId: 'w'
  })
  expect(readConversationEntry(target, 'unpaired')?.error).toBeInstanceOf(Error)
  expect(rpc).not.toHaveBeenCalled()
  replaceRuntimeEnvironmentRevisions([{ id: 'unpaired-entry', createdAt: 1, pairingRevision: 30 }])
  await retryConversationEntry(target, 'unpaired')
  expect(rpc).not.toHaveBeenCalled()
  forgetConversationEntriesOwnedBy({ workspaceId: 'w', executionHostId: 'runtime:unpaired-entry' })
  replaceRuntimeEnvironmentRevisions([])
})
