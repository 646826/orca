import { expect, it } from 'vitest'
import { agentSessionRefusalReasonWords } from './agent-session-refusal-reason-words'
import { parseAgentSessionWriteFailure } from './agent-session-write-failure'

it.each([
  ['conversationSwitchInFlight', 'conversationSwitchRunning', 'wait'],
  ['conversationParticipantParked', 'conversationParticipantParked', 'goElsewhere']
] as const)(
  'preserves the semantic switch refusal %s across transport',
  (reason, cause, action) => {
    const failure = parseAgentSessionWriteFailure({
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason }
    })
    expect(failure).toMatchObject({ details: { reason } })
    if (failure?.kind !== 'refused') {
      throw new Error('Expected a parsed refusal')
    }
    expect(agentSessionRefusalReasonWords(failure)).toMatchObject({ cause, action })
  }
)
