// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  active: 'a',
  selected: 'b',
  pending: false,
  phase: 'delivering'
}))
vi.mock('./use-native-chat-conversation', () => ({
  useNativeChatConversation: () => ({
    surface: {
      conversation: { contextGeneration: 1, pendingOperationKey: 'switch' },
      operation: {
        operationKey: 'switch',
        targetSessionId: state.selected,
        contextGeneration: 1,
        phase: state.phase
      },
      active: { sessionId: state.active, agent: 'codex' },
      selected: { sessionId: state.selected, agent: 'claude', agentLabel: 'Claude' },
      surface: {
        conversationId: 'c',
        sourceSessionId: 'founder',
        location: { workspaceId: 'w', executionHostId: 'local' }
      }
    },
    display: { messages: [] },
    error: false,
    refresh: async () => {}
  })
}))
vi.mock('./use-native-chat-conversation-controls', () => ({
  useNativeChatConversationControls: () => ({ notices: [], agentSwitch: { busy: false } })
}))
vi.mock('./use-native-chat-conversation-entry', () => ({
  useNativeChatConversationEntryStatus: () => ({
    pending: state.pending,
    busy: state.pending,
    notices: []
  })
}))
vi.mock('./NativeChatConversationControlsPanel', () => ({
  NativeChatConversationControlsPanel: () => null
}))
vi.mock('./NativeChatConversationCandidatePrompts', () => ({
  NativeChatConversationCandidatePrompts: (props: { sessionId: string }) => (
    <div data-testid="candidate-prompt">{props.sessionId}</div>
  )
}))
vi.mock('./NativeChatLoadingCue', () => ({ NativeChatLoadingCue: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))
vi.mock('./NativeChatView', () => ({
  default: (props: {
    sessionId: string
    conversationView: {
      controls: ReactNode
      composerScopeKey: string
      contextGeneration: number
      agentSwitch: { busy: boolean }
    }
  }) => (
    <>
      <output
        data-session={props.sessionId}
        data-busy={String(props.conversationView.agentSwitch.busy)}
        data-draft={props.conversationView.composerScopeKey}
      >
        {props.conversationView.contextGeneration}
      </output>
      {props.conversationView.controls}
    </>
  )
}))
import { NativeChatConversation } from './NativeChatConversation'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
afterEach(cleanup)
it('keeps the founding draft and routes native controls only to the committed active participant', () => {
  const props = {
    conversationId: 'c',
    target: { kind: 'local' as const },
    tabId: 'tab',
    groupId: 'group',
    isVisible: true,
    isFocusedGroup: true
  }
  const view = render(<NativeChatConversation {...props} />)
  expect(screen.getByRole('status').getAttribute('data-session')).toBe('a')
  const draft = structuredAgentSessionDraftScopeKey('founder')
  expect(screen.getByRole('status').getAttribute('data-draft')).toBe(draft)
  state.pending = true
  state.active = 'b'
  state.selected = 'c'
  view.rerender(<NativeChatConversation {...props} />)
  expect(screen.getByRole('status').getAttribute('data-session')).toBe('b')
  expect(screen.getByRole('status').getAttribute('data-busy')).toBe('true')
  expect(screen.getByRole('status').getAttribute('data-draft')).toBe(draft)
  state.active = 'a'
  view.rerender(<NativeChatConversation {...props} />)
  expect(screen.getByRole('status').getAttribute('data-session')).toBe('a')
  expect(screen.getByRole('status').getAttribute('data-draft')).toBe(draft)
})

it('mounts only the pending candidate response surface and removes it after activation', () => {
  state.active = 'a'
  state.selected = 'b'
  state.phase = 'delivering'
  const props = {
    conversationId: 'c',
    target: { kind: 'local' as const },
    tabId: 'tab',
    groupId: 'group',
    isVisible: true,
    isFocusedGroup: true
  }
  const view = render(<NativeChatConversation {...props} />)
  expect(screen.getByTestId('candidate-prompt').textContent).toBe('b')
  expect(screen.getByRole('status').getAttribute('data-session')).toBe('a')
  state.phase = 'activated'
  view.rerender(<NativeChatConversation {...props} />)
  expect(screen.queryByTestId('candidate-prompt')).toBeNull()
})
