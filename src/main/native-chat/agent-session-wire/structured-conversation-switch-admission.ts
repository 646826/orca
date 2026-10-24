import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire-refusals'

/** Additional aggregate admission only; never replaces the original runtime fence/receipt checks. */
export function conversationSwitchMutationRefusal(
  store: Pick<AgentSessionRecordStore, 'conversations'>,
  sessionId: string,
  method: string,
  fields: Readonly<Record<string, unknown>>,
  conversationMutationSupported?: boolean
): AgentSessionWireRefusal | null {
  // Settlement/control must remain live while the coordinator waits outside the session queue.
  if (
    method === 'agentSession.cancel' ||
    method === 'agentSession.respondTo:approval' ||
    method === 'agentSession.respondTo:question'
  ) {
    return null
  }
  const route = store.conversations.route(sessionId)
  if (route.role === 'unbound') {
    return null
  }
  if (conversationMutationSupported === false) {
    return refuse(
      'structured_agent_session_unsupported',
      { reason: 'clientCapabilityMissing' },
      'This client cannot mutate a multi-agent conversation.'
    )
  }
  if (route.role !== 'active') {
    return refuse(
      'agent_session_operation_invalid',
      { reason: 'conversationParticipantParked' },
      'This participant is not the active conversation agent.'
    )
  }
  if (route.mutation === 'clear') {
    return refuse(
      'agent_session_operation_invalid',
      { reason: 'conversationClearInFlight' },
      'Wait for the conversation context clear to finish.'
    )
  }
  const body = fields.body
  const command = body && typeof body === 'object' && 'command' in body ? body.command : null
  if (
    (method === 'agentSession.conversationCommand' && fields.command === 'clear') ||
    (method === 'agentSession.send' &&
      command &&
      typeof command === 'object' &&
      'name' in command &&
      command.name === 'clear')
  ) {
    return refuse(
      'agent_session_operation_invalid',
      { reason: 'conversationClearRequired' },
      'Clear context from the conversation controls to reset every participant.'
    )
  }
  if (!route.switching) {
    return null
  }
  // The existing queue path validates eligibility and forces a durable draft, never a submission.
  if (method === 'agentSession.send' && fields.delivery === 'queue-if-active') {
    return null
  }
  return refuse(
    'agent_session_operation_invalid',
    { reason: 'conversationSwitchInFlight' },
    'Wait for the conversation agent switch to finish.'
  )
}
