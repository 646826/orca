import { ConversationRefusal } from '../../native-chat/conversations/conversation-read-model'
import { expect, test } from 'vitest'
import { mapRuntimeError } from './errors'
import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
test('conversation refusal preserves a semantic reason independently of provider diagnostic prose', () => {
  const result = mapRuntimeError(
    'id',
    { runtimeId: 'runtime' },
    new ConversationRpcRefusal('stale-preview', 'copyable diagnostic')
  )
  expect(result.error).toEqual({
    code: 'conversation_refused',
    message: 'conversation_refused',
    data: { reason: 'stale-preview', errorText: 'copyable diagnostic' }
  })
})

test('store generation CAS refusal remains a semantic wire fact', () => {
  expect(
    mapRuntimeError('id', { runtimeId: 'runtime' }, new ConversationRefusal('stale-generation'))
      .error
  ).toMatchObject({ code: 'conversation_refused', data: { reason: 'stale-generation' } })
})
