import type * as EntryModule from './native-chat-conversation-entry'
// @vitest-environment happy-dom
import { cleanup, renderHook, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatConversationEntry } from './use-native-chat-conversation-entry'
const mocks = vi.hoisted(() => ({ supported: false, start: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => mocks.supported
}))
vi.mock('@/lib/structured-agent-session-launch-label', () => ({
  structuredAgentLabel: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./native-chat-conversation-entry', async (importOriginal) => ({
  ...(await importOriginal<typeof EntryModule>()),
  readConversationEntry: () => null,
  subscribeConversationEntry: () => () => {},
  startConversationEntry: mocks.start,
  retryConversationEntry: vi.fn()
}))
afterEach(() => {
  cleanup()
  mocks.start.mockReset()
  mocks.supported = false
})
it('does not offer mutation on unsupported hosts and keeps actual native agent after selection', () => {
  const input = {
    target: { kind: 'local' } as const,
    tabId: 'visual',
    sessionId: 'founder',
    workspaceId: 'w',
    agent: 'claude' as const,
    enabled: true
  }
  const { result, rerender } = renderHook(() => useNativeChatConversationEntry(input))
  expect(result.current.agentSwitch).toBeUndefined()
  mocks.supported = true
  rerender()
  act(() => result.current.agentSwitch?.onSelect('codex'))
  expect(mocks.start).toHaveBeenCalledWith({ ...input, agent: 'codex' })
  expect(result.current.agentSwitch?.active.id).toBe('claude')
})
