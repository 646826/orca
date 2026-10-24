import { expect, it } from 'vitest'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import { CALLER, hostTestState } from './structured-agent-session-host-test-harness'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
it('answers a real candidate prompt on its original fence before any delivery receipt or activation', async () => {
  const { host, store, targetId, intent } = await beginSwitch()
  const { acquire, answerPrompt } = hostTestState()
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('missing candidate events')
  }
  const identity = {
    provider: 'codex' as const,
    threadId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f61',
    turnId: 'turn-candidate',
    ordinal: 99
  }
  events.appendItem(
    identity,
    {
      kind: 'approval',
      title: 'Candidate permission',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(targetId)
  const page = await host.history({ sessionId: targetId, direction: 'tail' })
  const prompt = page.ok
    ? page.page.items.find((item) => item.itemId === agentJournalItemKey(identity))
    : null
  if (!prompt) {
    throw new Error('missing candidate prompt')
  }
  const before = store.conversations.read(intent.conversationId)
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  const response = await host.respondToPrompt(CALLER, {
    kind: 'approval',
    ...fields,
    envelope: {
      sessionId: targetId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(targetId)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.respondTo:approval',
        sessionId: targetId,
        fields
      })
    }
  })
  expect(response).toMatchObject({ ok: true })
  expect(answerPrompt).toHaveBeenCalledTimes(1)
  expect(answerPrompt.mock.calls[0][0]).toMatchObject({ sessionId: targetId })
  expect(store.conversations.read(intent.conversationId)?.activeSegmentId).toBe(
    before?.activeSegmentId
  )
  expect(store.conversations.intent(intent.operationKey)?.deliveryReceiptId).toBeNull()
})
