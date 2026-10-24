import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import type { ConversationPreparationView } from '../../../../shared/conversation-rpc'
import { useNativeChatConversationControls } from './use-native-chat-conversation-controls'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: () => 'fixed-operation'
}))
afterEach(() => {
  cleanup()
  replaceRuntimeEnvironmentRevisions([])
  rpc.mockReset()
})
const snapshot: ConversationSurfaceSnapshot = {
  conversation: {
    conversationId: 'c',
    revision: 1,
    contextGeneration: 1,
    activationFence: 1,
    activeSegmentId: 'segment-a',
    pendingOperationKey: null,
    location: {
      executionHostId: 'local',
      workspaceId: 'workspace',
      workspaceKind: 'git-worktree',
      wslDistro: null
    }
  },
  active: {
    sessionId: 'a',
    agent: 'claude',
    agentLabel: 'Claude Code',
    profile: { state: 'unknown' },
    authenticatedAccount: { state: 'unknown' },
    host: { id: 'host', label: 'Local' },
    workspace: { id: 'workspace', label: 'Project', kind: 'git-worktree', wslDistro: null },
    permissions: { selected: null, applied: null, state: 'unverified' },
    startupTrust: 'unobserved',
    transport: 'unverified'
  },
  selected: null,
  operation: null,
  surface: null
}
it('reserves one selection request despite two clicks before React commits busy state', async () => {
  let finish: ((value: unknown) => void) | undefined
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onRefresh = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useNativeChatConversationControls({ snapshot, target: { kind: 'local' }, onRefresh })
  )
  act(() => {
    result.current.agentSwitch.onSelect('codex')
    result.current.agentSwitch.onSelect('opencode')
  })
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0][1]).toBe('conversation.selectAgent')
  expect(rpc.mock.calls[0][2]).toMatchObject({
    agent: 'codex',
    clientOperationId: 'fixed-operation',
    expectedRevision: 1
  })
  await act(async () => finish?.({ decision: 'admitted', snapshot }))
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
  expect(result.current.notices).toEqual([])
})
it('sends exact manifest consent and does not silently substitute a new preview', async () => {
  rpc.mockResolvedValue(null)
  const onRefresh = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useNativeChatConversationControls({ snapshot, target: { kind: 'local' }, onRefresh })
  )
  const frozen: ConversationPreparationView = {
    operationKey: 'frozen-operation',
    conversationId: 'c',
    operationVersion: 7,
    contextGeneration: 2,
    phase: 'prepared',
    activeSessionId: 'a',
    selectedSessionId: 'b',
    approvalRevision: 2,
    target: null,
    status: 'preview',
    preview: {
      manifestDigest: 'manifest',
      targetBindingDigest: 'target',
      capabilityFingerprint: 'cap',
      transformationsDigest: 'transforms',
      omissionsDigest: 'omissions',
      policy: 'budgeted',
      completeness: 'budgeted-projection',
      sourceCount: 4,
      gapCount: 0,
      gapCountComplete: true,
      inputEstimate: 123,
      estimateConfidence: 'unknown',
      consented: false
    }
  }
  await act(async () => {
    await result.current.approveManifest(frozen)
  })
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0][1]).toBe('conversation.approveManifest')
  expect(rpc.mock.calls[0][2]).toEqual({
    operationKey: 'frozen-operation',
    expectedVersion: 7,
    expectedContextGeneration: 2,
    manifestDigest: 'manifest',
    targetBindingDigest: 'target',
    capabilityFingerprint: 'cap',
    transformationsDigest: 'transforms',
    omissionsDigest: 'omissions'
  })
})
it('does not replay a request after an unknown transport outcome', async () => {
  rpc.mockRejectedValue(new Error('connection closed'))
  const onRefresh = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useNativeChatConversationControls({ snapshot, target: { kind: 'local' }, onRefresh })
  )
  act(() => result.current.agentSwitch.onSelect('codex'))
  await waitFor(() => expect(result.current.notices.length).toBe(1))
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(onRefresh).toHaveBeenCalledTimes(1)
})
it('retains reviewed evidence without a mutation refresh erasing the page', async () => {
  const page = {
    manifestDigest: 'm',
    targetBindingDigest: 't',
    transformationsDigest: 'x',
    omissionsDigest: 'o',
    sourceRevision: 'r',
    manifestGaps: [],
    entries: [],
    next: null,
    complete: true
  }
  rpc.mockResolvedValue(page)
  const onRefresh = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useNativeChatConversationControls({ snapshot, target: { kind: 'local' }, onRefresh })
  )
  const view = evidenceView
  await act(async () => {
    await result.current.readEvidence(view)
  })
  expect(result.current.evidence).toEqual(page)
  expect(onRefresh).not.toHaveBeenCalled()
})
it('discards an evidence reply from the previous execution host', async () => {
  let finish: ((value: unknown) => void) | undefined
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(
    ({ target }: { target: RuntimeClientTarget }) =>
      useNativeChatConversationControls({ snapshot, target, onRefresh: async () => {} }),
    { initialProps: { target: { kind: 'local' } } }
  )
  const view = evidenceView
  let pending: Promise<void> | undefined
  act(() => {
    pending = result.current.readEvidence(view)
  })
  rerender({ target: { kind: 'environment', environmentId: 'different-host' } })
  await act(async () => {
    finish?.({
      manifestDigest: 'm',
      targetBindingDigest: 't',
      transformationsDigest: 'x',
      omissionsDigest: 'o',
      sourceRevision: 'r',
      manifestGaps: [],
      entries: [],
      next: null,
      complete: true
    })
    await pending
  })
  expect(result.current.evidence).toBeNull()
})

const evidenceView: ConversationPreparationView = {
  operationKey: 'op',
  conversationId: 'c',
  operationVersion: 1,
  contextGeneration: 1,
  phase: 'prepared',
  activeSessionId: 'a',
  selectedSessionId: 'b',
  approvalRevision: 1,
  target: null,
  status: 'preview',
  preview: {
    manifestDigest: 'm',
    targetBindingDigest: 't',
    capabilityFingerprint: 'c',
    transformationsDigest: 'x',
    omissionsDigest: 'o',
    policy: 'budgeted',
    completeness: 'budgeted-projection',
    sourceCount: 1,
    gapCount: 0,
    gapCountComplete: true,
    inputEstimate: 1,
    estimateConfidence: 'unknown',
    consented: false
  }
}

it('discards old evidence when a newer preview revision arrives on the same operation', async () => {
  let finish: ((value: unknown) => void) | undefined
  rpc.mockImplementation((_target, method) =>
    method === 'conversation.preparationEvidence'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(null)
  )
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useNativeChatConversationControls({
        snapshot: {
          ...snapshot,
          conversation: { ...snapshot.conversation, revision },
          operation: {
            operationKey: 'op',
            conversationId: 'c',
            targetSessionId: 'b',
            candidateSegmentId: 'candidate',
            contextGeneration: 1,
            activationFence: 2,
            nativeBindingGeneration: 1,
            version: revision,
            phase: 'prepared',
            sourceBoundaryCount: 1,
            candidateBoundaryCount: 1
          }
        },
        target: { kind: 'local' },
        onRefresh: async () => {}
      }),
    { initialProps: { revision: 1 } }
  )
  let pending: Promise<void> | undefined
  act(() => {
    pending = result.current.readEvidence(evidenceView)
  })
  rerender({ revision: 2 })
  await act(async () => {
    finish?.({
      manifestDigest: 'm',
      targetBindingDigest: 't',
      transformationsDigest: 'x',
      omissionsDigest: 'o',
      sourceRevision: 'r',
      manifestGaps: [],
      entries: [],
      next: null,
      complete: true
    })
    await pending
  })
  expect(result.current.evidence).toBeNull()
})
it('does not show a failed old-host refresh on the newly selected host', async () => {
  rpc.mockResolvedValue({ decision: 'admitted', snapshot })
  let rejectRefresh: ((cause: Error) => void) | undefined
  const onRefresh = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectRefresh = reject
      })
  )
  const { result, rerender } = renderHook(
    ({ target }: { target: RuntimeClientTarget }) =>
      useNativeChatConversationControls({ snapshot, target, onRefresh }),
    { initialProps: { target: { kind: 'local' } } }
  )
  act(() => result.current.agentSwitch.onSelect('codex'))
  await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
  rerender({ target: { kind: 'environment', environmentId: 'new-host' } })
  await act(async () => rejectRefresh?.(new Error('old host disconnected')))
  expect(result.current.notices).toEqual([])
})

it('keeps the mounted controls bound to the original pairing of a remote alias', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'controls-host', createdAt: 1, pairingRevision: 10 }])
  rpc.mockResolvedValue({ decision: 'admitted', snapshot })
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot,
      target: { kind: 'environment', environmentId: 'controls-host' },
      onRefresh: async () => {}
    })
  )
  await act(async () => {
    await result.current.select('codex')
  })
  expect(rpc.mock.calls[0][3]).toMatchObject({ expectedEnvironmentPairingRevision: 10 })
  replaceRuntimeEnvironmentRevisions([{ id: 'controls-host', createdAt: 1, pairingRevision: 20 }], {
    retired: ['controls-host'],
    sameHost: []
  })
  await act(async () => {
    await result.current.select('opencode')
  })
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(result.current.notices).toHaveLength(1)
  replaceRuntimeEnvironmentRevisions([])
})

it('refuses a newly paired host when controls mounted without an owner', async () => {
  replaceRuntimeEnvironmentRevisions([])
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot,
      target: { kind: 'environment', environmentId: 'unpaired-controls' },
      onRefresh: async () => {}
    })
  )
  replaceRuntimeEnvironmentRevisions([{ id: 'unpaired-controls', createdAt: 1 }])
  await act(async () => {
    await result.current.select('codex')
  })
  expect(rpc).not.toHaveBeenCalled()
  expect(result.current.notices).toHaveLength(1)
})

it('rejects a late selection receipt after the captured host is replaced', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'late-controls', createdAt: 10 }])
  let finish: ((value: unknown) => void) | undefined
  rpc.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot,
      target: { kind: 'environment', environmentId: 'late-controls' },
      onRefresh: async () => {}
    })
  )
  let pending: Promise<void> | undefined
  act(() => {
    pending = result.current.select('codex')
  })
  const beforeSend = rpc.mock.calls[0][3].beforeSend
  replaceRuntimeEnvironmentRevisions([{ id: 'late-controls', createdAt: 20 }], {
    retired: ['late-controls'],
    sameHost: []
  })
  expect(beforeSend).toThrow('Conversation owner changed')
  await act(async () => {
    finish?.({ decision: 'admitted', snapshot })
    await pending
  })
  expect(result.current.notices).toHaveLength(1)
  expect(rpc).toHaveBeenCalledTimes(1)
})

it('keeps retired controls fenced even if an alias reuses its old numeric revision', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'reused-controls', createdAt: 10 }])
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot,
      target: { kind: 'environment', environmentId: 'reused-controls' },
      onRefresh: async () => {}
    })
  )
  replaceRuntimeEnvironmentRevisions([], { retired: ['reused-controls'], sameHost: [] })
  replaceRuntimeEnvironmentRevisions([{ id: 'reused-controls', createdAt: 10 }])
  await act(async () => {
    await result.current.select('codex')
  })
  expect(rpc).not.toHaveBeenCalled()
  expect(result.current.notices).toHaveLength(1)
})

it('an older host omitting recovery never receives a blind recovery or intentions RPC', async () => {
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot,
      target: { kind: 'local' },
      onRefresh: async () => {}
    })
  )
  expect(result.current.transferRecovery).toBeUndefined()
  await act(async () => {
    await result.current.readOlderIntentions()
  })
  expect(rpc).not.toHaveBeenCalled()
})

it('return sends only the exact advertised CAS scope and never follows it with Send, Resume or advance', async () => {
  const intention = {
    transferId: 'transfer',
    kind: 'trigger' as const,
    operationKey: 'op',
    targetSessionId: 'b',
    sourceSessionId: 'a',
    sourceMessageId: 'draft',
    status: 'message-not-sent' as const,
    actions: ['return-held-draft' as const],
    scope: {
      operationKey: 'op',
      transferId: 'transfer',
      expectedVersion: 1,
      expectedRevision: 1,
      expectedContextGeneration: 1,
      expectedActivationFence: 1,
      expectedNativeBindingGeneration: 1,
      expectedRuntimeFence: 1,
      expectedTargetEpoch: 'epoch',
      expectedRecoveryAttempt: 0,
      expectedProofDigest: 'a'.repeat(64)
    },
    original: {
      text: 'Client preview is not authority',
      truncated: true,
      bodyBytes: 12000,
      bodyDigest: 'b'.repeat(64),
      attachmentCount: 1
    }
  }
  rpc.mockResolvedValue({
    transferId: 'transfer',
    operationKey: 'op',
    action: 'return-held-draft',
    sourceSessionId: 'a',
    sourceMessageId: 'draft',
    conversationRevision: 2,
    operationVersion: 2
  })
  const onRefresh = vi.fn(async () => {})
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot: {
        ...snapshot,
        transferRecovery: { version: 1, intentions: [intention], next: null }
      },
      target: { kind: 'local' },
      onRefresh
    })
  )
  await act(async () => {
    await result.current.recoverTransfer(intention, 'return-held-draft')
  })
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0]?.[1]).toBe('conversation.recoverTransfer')
  expect(rpc.mock.calls[0]?.[2]).toEqual({
    ...intention.scope,
    action: 'return-held-draft',
    clientOperationId: 'fixed-operation'
  })
  expect(onRefresh).toHaveBeenCalledTimes(1)
})

it('Refresh status only rereads advertised retained intentions and does not advance or send', async () => {
  const transferRecovery = { version: 1 as const, intentions: [], next: null }
  rpc.mockResolvedValue(transferRecovery)
  const { result } = renderHook(() =>
    useNativeChatConversationControls({
      snapshot: { ...snapshot, transferRecovery },
      target: { kind: 'local' },
      onRefresh: vi.fn(async () => {})
    })
  )
  await act(async () => {
    await result.current.reconcileTransferStatus()
  })
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(rpc.mock.calls[0]?.[1]).toBe('conversation.transferIntentions')
  expect(rpc.mock.calls[0]?.[2]).toEqual({ conversationId: 'c', before: null })
})
