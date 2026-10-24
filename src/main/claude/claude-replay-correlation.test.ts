import { expect, it, vi } from 'vitest'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { resolveClaudeReplayTurn } from './claude-replay-turn-resolution'
import { sessionFor, userMessage, userReplayFrame } from './claude-structured-dispatch-test-support'

it.each([true, false])('marks only exact UUID acceptance (exact=%s)', async (exact) => {
  const session = sessionFor()
  const settled = vi.fn()
  await dispatchClaudeTurn(session, {
    clientMessageId: 'source',
    body: userMessage([{ type: 'text', text: 'same text' }])
  })
  const uuid = session.dispatchWaiters[0]!.sentUuid
  const origin = resolveClaudeReplayTurn(
    session,
    userReplayFrame(exact ? uuid : 'provider-reminted', 'same text'),
    settled
  )
  expect(origin?.originCorrelation).toBe(exact ? 'exact' : undefined)
  expect(settled).toHaveBeenCalledTimes(1)
  expect(settled.mock.calls[0]![0].originCorrelation).toBe(exact ? 'exact' : undefined)
})
