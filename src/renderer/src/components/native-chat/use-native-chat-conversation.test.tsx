// @vitest-environment happy-dom
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { StrictMode, useLayoutEffect } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
const lifecycle = vi.hoisted(() => ({ live: new Set<number>(), next: 0 }))
vi.mock('@/runtime/runtime-conversation-reader', () => ({
  createRuntimeConversationReader: (target: RuntimeClientTarget) => ({ target })
}))
vi.mock('./native-chat-conversation-reader', () => ({
  createConversationReaderState: (port: { target: RuntimeClientTarget }) => {
    const id = lifecycle.next++
    let closed = false
    const state = {
      surface: {
        active: {
          agent: 'codex',
          sessionId: port.target.kind === 'local' ? 'local-owner' : port.target.environmentId
        }
      },
      rows: [],
      loading: false,
      error: false,
      hasMore: false,
      loadingOlder: false,
      generation: 0,
      readCurrent: true
    }
    return {
      getSnapshot: () => state,
      subscribe: () => () => {},
      start: async () => {
        if (closed) {
          throw new Error('Disposed reader restarted')
        }
        lifecycle.live.add(id)
      },
      close: () => {
        closed = true
        lifecycle.live.delete(id)
      },
      refresh: async () => {},
      loadEarlier: async () => 'exhausted'
    }
  }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_id: string, value: string) => value }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_id: string, text: string) => text })
}))
import { useNativeChatConversation } from './use-native-chat-conversation'
it('owns a fresh reader for StrictMode effect replay and closes it on unmount', async () => {
  const result = renderHook(() => useNativeChatConversation('c', { kind: 'local' }, true), {
    wrapper: StrictMode
  })
  await waitFor(() => expect(lifecycle.live.size).toBe(1))
  result.unmount()
  expect(lifecycle.live.size).toBe(0)
})

it('never exposes the old owner under a new host during the pre-effect layout', () => {
  const observations: { host: string; owner: string | null }[] = []
  const result = renderHook(
    ({ host }: { host: string }) => {
      const state = useNativeChatConversation(
        'same-conversation',
        { kind: 'environment', environmentId: host },
        true
      )
      useLayoutEffect(() => {
        observations.push({ host, owner: state.surface?.active.sessionId ?? null })
      })
      return state
    },
    { initialProps: { host: 'first' } }
  )
  result.rerender({ host: 'second' })
  expect(observations.some((entry) => entry.host === 'second' && entry.owner === 'first')).toBe(
    false
  )
  expect(observations.find((entry) => entry.host === 'second')?.owner).toBeNull()
  expect(result.result.current.surface?.active.sessionId).toBe('second')
  result.unmount()
})
