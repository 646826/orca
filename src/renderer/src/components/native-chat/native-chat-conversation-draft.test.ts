// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import {
  conversationDraftScopeKey,
  registerConversationDraftOwner,
  conversationDraftOwner
} from './native-chat-conversation-draft'
import {
  addNativeChatPendingAttachment,
  settleNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
const surface = {
  conversationId: 'conversation',
  sourceSessionId: 'founder',
  tabId: 'same-tab',
  location: {
    executionHostId: 'local' as const,
    workspaceId: 'folder',
    workspaceKind: 'folder' as const,
    wslDistro: null
  },
  visible: true,
  surfaceRevision: 1,
  publishedRevision: 1
}
afterEach(() => clearNativeChatComposerDraftsForTests())
it('keeps the original draft and pending upload through promotion and repeated native activation', () => {
  const original = structuredAgentSessionDraftScopeKey('founder')
  updateNativeChatComposerDraft(original, { text: 'Unsent 日本語' }, 'immediate')
  addNativeChatPendingAttachment(original, { id: 'upload', path: '', pending: true })
  const close = registerConversationDraftOwner(surface)
  try {
    expect(conversationDraftScopeKey(surface)).toBe(original)
    expect(conversationDraftScopeKey({ ...surface, sourceSessionId: 'founder' })).toBe(original)
    expect(conversationDraftOwner(original)).toEqual({
      workspaceId: 'folder',
      executionHostId: 'local'
    })
    expect(settleNativeChatPendingAttachment(original, 'upload', '/managed/upload.png')).toBe(true)
    expect(readNativeChatComposerDraft(conversationDraftScopeKey(surface))).toMatchObject({
      text: 'Unsent 日本語',
      images: [{ id: 'upload', path: '/managed/upload.png' }]
    })
  } finally {
    close()
  }
  expect(conversationDraftOwner(original)).toBeUndefined()
})
