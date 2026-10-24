import { ConversationRefusal } from '../conversations/conversation-read-model'
import type { PromoteConversationSurface } from '../conversations/conversation-tab-surface-store'
import { foundStructuredConversationCandidate } from './structured-conversation-candidate'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { ConversationSwitchRequest } from '../../../shared/conversation-wire'
import type { AgentSessionOperationAdmission } from '../../runtime/agent-session-operation-admission'

/** Membership commits join the native session queue; quiescence never holds that queue. */
export function structuredConversationEnrollment(
  context: () => StructuredAgentSessionAttachContext
) {
  return {
    promote(request: PromoteConversationSurface, admission: () => void) {
      const ctx = context()
      return ctx.serialize(request.sourceSessionId, () =>
        ctx.deps.store.conversations.surfaces.promote(request, admission)
      )
    },
    found(
      ...args: Parameters<typeof foundStructuredConversationCandidate> extends [
        unknown,
        ...infer Rest
      ]
        ? Rest
        : never
    ) {
      return foundStructuredConversationCandidate(context(), ...args)
    },
    ensure(sessionId: string) {
      const ctx = context()
      return ctx.serialize(sessionId, () => {
        if (
          !ctx.deps.store.conversations.membership(sessionId) &&
          ctx.deps.store.getRecord(sessionId)?.lease.claimStatus === 'reserved'
        ) {
          throw new ConversationRefusal('busy')
        }
        const child = ctx.sessions.get(sessionId)?.child
        const acquisition =
          child?.phase === 'starting' && child.generation && !child.close
            ? { generation: child.generation, fence: child.fence }
            : undefined
        return ctx.deps.store.conversations.ensureSingleton(sessionId, acquisition)
      })
    },
    begin(request: ConversationSwitchRequest, operation: AgentSessionOperationAdmission) {
      const ctx = context()
      return ctx.serialize(request.target.sessionId, () =>
        ctx.deps.store.conversations.beginSwitch(request, operation)
      )
    }
  }
}
