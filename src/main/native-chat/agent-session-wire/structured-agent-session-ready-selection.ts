import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { AgentSessionMutationSessionPreparation } from './structured-agent-session-mutation-admission'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { openForWrite } from './structured-agent-session-send-preparation'
import { selectStructuredAgentSessionOperationChild } from './structured-agent-session-operation-child'

export type ReadyOperationPlan<T> = { conversationMutationSupported?: boolean } & Pick<
  MutationPlan<T>,
  'method' | 'fields' | 'operationIdScope' | 'commandReceipt'
> &
  Partial<
    Pick<MutationPlan<T>, 'replay' | 'rerunWhenReplayMissing' | 'recoverUnknownFromDurableState'>
  >

export async function selectReadyOperationChild(
  context: StructuredAgentSessionMutationContext,
  envelope: AgentSessionMutationEnvelope,
  mutationRefusal: () => AgentSessionWireRefusal | null,
  beforeAgent?: (record: AgentSessionRecord | null) => AgentSessionMutationSessionPreparation | null
) {
  const opened = await openForWrite(context, envelope)()
  if (!opened.ok) {
    return opened
  }
  const changed = mutationRefusal()
  if (changed) {
    return { ok: false as const, refusal: changed }
  }
  const checked = beforeAgent?.(context.deps.store.getRecord(envelope.sessionId))
  if (checked && !checked.ok) {
    return checked
  }
  return selectStructuredAgentSessionOperationChild(context, envelope.sessionId)
}
