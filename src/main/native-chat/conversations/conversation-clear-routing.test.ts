import { expect, it } from 'vitest'
import { beginSwitch } from '../agent-session-wire/structured-conversation-switch.test-fixture'
import { conversationSwitchMutationRefusal } from '../agent-session-wire/structured-conversation-switch-admission'
import { readConversationPendingMutation } from './conversation-pending-mutation'

it('routes a pending clear without inventing a candidate and preserves settlement controls', async () => {
  const { host, store, intent } = await beginSwitch()
  const db = host.deps.journalDatabase.db
  const clear = {
    operationKey: 'clear-operation',
    conversationId: intent.conversationId,
    version: 1,
    contextGeneration: intent.contextGeneration,
    activationFence: store.conversations.read(intent.conversationId)!.activationFence,
    phase: 'quiescing',
    preserveArchive: true,
    sourceBoundaries: intent.sourceBoundaries,
    participants: [
      {
        sessionId: intent.sourceBoundaries[0]!.sessionId,
        nativeBindingGeneration: 1,
        runtimeFence: 1,
        recordBirthDigest: 'a'.repeat(64)
      }
    ]
  }
  db.prepare('INSERT INTO conversation_clear_intents VALUES (?,?,?)').run(
    clear.operationKey,
    clear.conversationId,
    JSON.stringify(clear)
  )
  db.prepare(
    "UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey',?) WHERE conversation_id=?"
  ).run(clear.operationKey, clear.conversationId)
  const conversation = store.conversations.read(clear.conversationId)!
  expect(readConversationPendingMutation(db, conversation)?.kind).toBe('clear')
  const sessionId = clear.participants[0]!.sessionId
  expect(store.conversations.route(sessionId)).toMatchObject({
    role: 'active',
    mutation: 'clear',
    switching: false
  })
  expect(
    conversationSwitchMutationRefusal(
      store,
      sessionId,
      'agentSession.send',
      { delivery: 'queue-if-active' },
      true
    )
  ).not.toBeNull()
  for (const method of [
    'agentSession.cancel',
    'agentSession.respondTo:approval',
    'agentSession.respondTo:question'
  ]) {
    expect(conversationSwitchMutationRefusal(store, sessionId, method, {}, true)).toBeNull()
  }
  db.prepare(
    "UPDATE conversation_clear_intents SET record_json=json_set(record_json,'$.phase','committed') WHERE operation_key=?"
  ).run(clear.operationKey)
  expect(() => readConversationPendingMutation(db, conversation)).toThrow('corrupt-record')
})
