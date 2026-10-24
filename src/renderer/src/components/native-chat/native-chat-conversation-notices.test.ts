import { expect, it, vi } from 'vitest'
import type { ConversationOperationView } from '../../../../shared/conversation-rpc'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  nativeChatConversationNotice,
  nativeChatConversationRequestFailure
} from './native-chat-conversation-notices'
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const intent: ConversationOperationView = {
  operationKey: 'operation',
  conversationId: 'conversation',
  targetSessionId: 'b',
  candidateSegmentId: 'candidate',
  contextGeneration: 1,
  activationFence: 2,
  nativeBindingGeneration: 1,
  version: 2,
  phase: 'quiescing',
  sourceBoundaryCount: 1,
  candidateBoundaryCount: 1
}
it('does not equate selection, dispatch or uncertain acceptance with activation', () => {
  expect(nativeChatConversationNotice(intent)?.text).toContain('settle')
  expect(nativeChatConversationNotice({ ...intent, phase: 'delivering' })?.text).toContain(
    'not yet active'
  )
  const uncertain = nativeChatConversationNotice({ ...intent, phase: 'reconciliation-required' })
  expect(uncertain?.text).toContain('Do not resend')
  expect(uncertain?.action).toBeUndefined()
  expect(nativeChatConversationNotice({ ...intent, phase: 'activated' })).toBeNull()
})
it('keeps an untranslated provider error apart from Orca status text', () => {
  const notice = nativeChatConversationNotice(intent, {
    reason: 'trust-required',
    errorText: 'native: 未授权'
  })
  expect(notice?.text).toContain('startup')
  expect(notice?.text).not.toContain('未授权')
  expect(notice?.errorText).toBe('native: 未授权')
})

it.each(['trust-required', 'native-rebuild-required'] as const)(
  'renders semantic RPC refusal %s with separate provider detail',
  (reason) => {
    const failure = new RuntimeRpcCallError({
      id: 'request',
      ok: false,
      error: {
        code: 'conflict',
        message: 'conversation_refused',
        data: { reason, errorText: 'provider: 未授权' }
      }
    })
    const notice = nativeChatConversationRequestFailure(failure)
    expect(notice.text).toBe(nativeChatConversationNotice(null, { reason })?.text)
    expect(notice.errorText).toBe('provider: 未授权')
  }
)
