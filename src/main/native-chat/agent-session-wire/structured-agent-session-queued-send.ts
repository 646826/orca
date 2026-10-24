// A send's queue step around its immediate path: the queue decision before it. Its
// accepted turn lifts a paused queue (`queued-message-pause.ts`), not anything here.

import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  maybeQueueStructuredAgentSessionSend,
  conversationQueueHeld
} from './structured-agent-session-queued-messages'
import { refuse } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function runQueueableStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: AgentSessionTurnContext,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    queuedImageCards?: boolean
    options?: Readonly<Record<string, string>>
    userSend?: true
    personsMessage?: true
  },
  immediate: () => Promise<TurnOutcome<AgentSessionSendResult>>
): Promise<TurnOutcome<AgentSessionSendResult>> {
  // The queue decision runs first: a capable send while the session owes work (a
  // /compact included — it is a queued message like any other) becomes a draft;
  // only a `blocked` hold, which never queues, falls through to the refusal.
  const queued = await maybeQueueStructuredAgentSessionSend(context, ctx, params)
  if (queued) {
    return queued
  }
  if (
    conversationQueueHeld(context.deps.store.conversations.route(ctx.sessionId)) &&
    !ctx.journal.submission(params.envelope.clientOperationId)
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'conversationSwitchInFlight' },
        'This client cannot queue this message during an agent switch.'
      )
    }
  }
  return immediate()
}
