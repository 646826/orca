// @vitest-environment happy-dom
import { StrictMode, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useConversationCandidatePrompts } from './use-conversation-candidate-prompts'
const f = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  actionMutate: vi.fn(),
  actionWrite: vi.fn(),
  admit: vi.fn(),
  readCurrent: true,
  capability: vi.fn<() => Promise<boolean>>()
}))
vi.mock('./use-structured-agent-session-read', () => ({ useStructuredAgentSessionRead: f.read }))
vi.mock('./use-structured-agent-session-mutate', () => ({
  useStructuredAgentSessionMutate: (input: {
    target: RuntimeClientTarget
    stateRef: { current: { fence: number | null } }
  }) => ({
    mutate: f.mutate,
    admit: () => f.admit(input.target, input.stateRef.current.fence)
  })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsStructuredAgentSessionQuestionAnswers: f.capability,
  supportsStructuredAgentSessionPromptCancel: f.capability
}))
beforeEach(() => {
  f.admit.mockImplementation((target: RuntimeClientTarget) => ({
    target,
    mutate: f.actionMutate,
    write: f.actionWrite
  }))
  f.actionMutate.mockResolvedValue({})
})
afterEach(() => {
  expect(f.mutate).not.toHaveBeenCalled()
  cleanup()
  vi.clearAllMocks()
})
it('answers a candidate approval before activation using candidate state and never an active-session transport', async () => {
  const prompt = {
    itemId: 'candidate-approval',
    revision: 3,
    sequence: 2,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  f.read.mockReturnValue({
    readCurrent: true,
    state: {
      fence: 7,
      items: [prompt],
      currentRequests: [prompt],
      actionablePromptIds: [prompt.itemId]
    }
  })
  f.actionMutate.mockResolvedValue({})
  const { result, rerender } = renderHook(
    ({ sessionId }) =>
      useConversationCandidatePrompts({ sessionId, target: { kind: 'local' }, isVisible: true }),
    { initialProps: { sessionId: 'candidate-b' } }
  )
  expect(f.read).toHaveBeenCalledWith({
    sessionId: 'candidate-b',
    target: { kind: 'local' },
    isVisible: true,
    isViewed: false
  })
  const oldRespond = result.current.respond
  await act(() =>
    result.current.respond(result.current.prompts[0], { kind: 'option', optionId: 'allow' })
  )
  expect(f.actionMutate).toHaveBeenCalledWith(
    'agentSession.respondToApproval',
    'agentSession.respondTo:approval',
    { itemId: 'candidate-approval', expectedRevision: 3, optionId: 'allow' }
  )
  f.read.mockReturnValue({
    readCurrent: true,
    state: {
      fence: 8,
      items: [prompt],
      currentRequests: [prompt],
      actionablePromptIds: [prompt.itemId]
    }
  })
  rerender({ sessionId: 'candidate-b' })
  await act(() => oldRespond(result.current.prompts[0], { kind: 'option', optionId: 'allow' }))
  expect(f.actionMutate).toHaveBeenCalledTimes(1)
  rerender({ sessionId: 'candidate-c' })
  await act(() => oldRespond(result.current.prompts[0], { kind: 'option', optionId: 'allow' }))
  expect(f.actionMutate).toHaveBeenCalledTimes(1)
})

it.each([
  'fence',
  'target',
  'session',
  'revision',
  'hidden',
  'stale',
  'unmounted',
  'hidden-returned'
] as const)(
  'does not answer after deferred capability discovery when candidate becomes %s',
  async (change) => {
    let resolveCapability!: (supported: boolean) => void
    f.capability.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCapability = resolve
        })
    )
    const prompt = {
      itemId: 'question',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'question',
        question: 'Which?',
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
    const state = {
      fence: 7,
      items: [prompt],
      currentRequests: [prompt],
      actionablePromptIds: ['question']
    }
    f.read.mockReturnValue({ readCurrent: true, state })
    const { result, rerender, unmount } = renderHook(
      ({ isVisible, sessionId, environmentId }) =>
        useConversationCandidatePrompts({
          sessionId,
          target: { kind: 'environment', environmentId },
          isVisible
        }),
      { initialProps: { isVisible: true, sessionId: 'candidate', environmentId: 'host-a' } }
    )
    const pending = result.current.respond(result.current.prompts[0], {
      kind: 'answers',
      answers: []
    })
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'host-a' },
      7
    )
    expect(f.capability).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'host-a' })
    expect(f.admit.mock.invocationCallOrder[0]).toBeLessThan(
      f.capability.mock.invocationCallOrder[0]
    )
    expect(f.actionMutate).not.toHaveBeenCalled()
    if (change === 'unmounted') {
      unmount()
    } else {
      f.read.mockReturnValue({
        readCurrent: change !== 'stale',
        state: {
          ...state,
          fence: change === 'fence' ? 8 : 7,
          ...(change === 'revision'
            ? {
                items: [{ ...prompt, revision: 2 }],
                currentRequests: [{ ...prompt, revision: 2 }]
              }
            : {})
        }
      })
      rerender({
        isVisible: change !== 'hidden' && change !== 'hidden-returned',
        sessionId: change === 'session' ? 'replacement' : 'candidate',
        environmentId: change === 'target' ? 'host-b' : 'host-a'
      })
      if (change === 'hidden-returned') {
        rerender({ isVisible: true, sessionId: 'candidate', environmentId: 'host-a' })
      }
    }
    await act(async () => {
      resolveCapability(true)
      await pending
    })
    expect(f.actionMutate).not.toHaveBeenCalled()
  }
)
it('rechecks deferred prompt cancellation and accepts a current StrictMode effect lifetime', async () => {
  let resolveCapability!: (supported: boolean) => void
  f.capability.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCapability = resolve
      })
  )
  const prompt = {
    itemId: 'approval',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  const state = {
    fence: 7,
    items: [prompt],
    currentRequests: [prompt],
    actionablePromptIds: ['approval']
  }
  f.read.mockReturnValue({ readCurrent: true, state })
  const { result, rerender } = renderHook(
    () =>
      useConversationCandidatePrompts({
        sessionId: 'candidate',
        target: { kind: 'local' },
        isVisible: true
      }),
    { wrapper: ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode> }
  )
  await act(() =>
    result.current.respond(result.current.prompts[0], { kind: 'option', optionId: 'allow' })
  )
  expect(f.actionMutate).toHaveBeenCalledTimes(1)
  f.actionMutate.mockClear()
  const pending = result.current.cancel(result.current.prompts[0])
  f.read.mockReturnValue({ readCurrent: true, state: { ...state, fence: 8 } })
  rerender()
  await act(async () => {
    resolveCapability(true)
    await pending
  })
  expect(f.actionMutate).not.toHaveBeenCalled()
})

it('uses the admitted action for a current cancellation and preserves already-dispatched settlement', async () => {
  const prompt = {
    itemId: 'approval',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  const state = {
    fence: 7,
    items: [prompt],
    currentRequests: [prompt],
    actionablePromptIds: ['approval']
  }
  f.read.mockReturnValue({ readCurrent: true, state })
  f.capability.mockResolvedValue(true)
  const { result, rerender } = renderHook(
    ({ sessionId }) =>
      useConversationCandidatePrompts({
        sessionId,
        target: { kind: 'local' },
        isVisible: true
      }),
    { initialProps: { sessionId: 'candidate' } }
  )
  await act(() => result.current.cancel(result.current.prompts[0]))
  expect(f.admit).toHaveBeenCalledExactlyOnceWith({ kind: 'local' }, 7)
  expect(f.actionMutate).toHaveBeenCalledExactlyOnceWith(
    'agentSession.cancel',
    'agentSession.cancel',
    {
      prompt: { itemId: 'approval', expectedRevision: 1 }
    }
  )
  let settle!: (result: unknown) => void
  f.actionMutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  const pending = result.current.respond(result.current.prompts[0], {
    kind: 'option',
    optionId: 'allow'
  })
  expect(f.actionMutate).toHaveBeenCalledTimes(2)
  f.read.mockReturnValue({ readCurrent: true, state: { ...state, fence: 8 } })
  rerender({ sessionId: 'replacement' })
  const accepted = {
    itemId: 'approval',
    revision: 2,
    resolution: {
      state: 'answered',
      selectedOptionId: 'allow',
      resolvedBy: 'caller',
      resolvedAt: 2
    }
  }
  await act(async () => {
    settle(accepted)
    expect(await pending).toEqual(accepted)
  })
  expect(f.actionMutate).toHaveBeenCalledTimes(2)
  expect(f.admit).toHaveBeenCalledTimes(2)
})
