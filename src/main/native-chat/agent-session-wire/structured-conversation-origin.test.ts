import { expect, it } from 'vitest'
import { hostTestState } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import { ConversationOriginUnresolvedError } from '../conversations/conversation-origin'
import { assertConversationOriginsResolved } from '../conversations/conversation-origin-rows'

it('records unresolved facts through the production host journal opener', async () => {
  const { host, intent } = await beginSwitch()
  const session = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)
  if (!session) {
    throw new Error('missing production journal')
  }
  await session.journal.appendItem(
    { provider: 'codex', threadId: 'unknown-provider-thread', turnId: 'late', ordinal: 1 },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'unmapped event' }] },
    {
      fence: hostTestState().store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      turnScope: { kind: 'thread' }
    }
  )
  expect(() =>
    assertConversationOriginsResolved(
      host.deps.journalDatabase.db,
      intent.conversationId,
      intent.contextGeneration
    )
  ).toThrow(ConversationOriginUnresolvedError)
  expect(session.journal.snapshot().items.some((item) => item.body.kind === 'message')).toBe(true)
})
