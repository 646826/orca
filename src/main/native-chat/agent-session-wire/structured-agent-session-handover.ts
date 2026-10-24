import type { ConversationContextDispatchObserver } from './structured-conversation-context-dispatch'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import {
  createConversationTransferNoWriteRecorder,
  type ConversationNoUserTurnWriteReason
} from '../conversations/conversation-transfer-no-write'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
// Handing one accepted message to the provider: two commits around a provider call that runs
// outside the session's serialize, so a send is accepted while the call is in flight.

import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { StructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { isAbortSignalReason } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { DISPATCH_DOUBT_PERSISTENCE_FAILED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  handOverStructuredAgentSessionCommand,
  structuredAgentSessionHandoverOrigin,
  type StructuredAgentSessionCommandHandoverContext
} from './structured-agent-session-command-turn'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import { carriedStoppedHistory } from './structured-agent-session-stopped-history-selection'
import { withStoppedHistory } from '../../../shared/agent-session-stopped-history'
import {
  beginStructuredAgentSessionHandover,
  whileStructuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

export type AgentSessionHandoverContext = StructuredAgentSessionCommandHandoverContext & {
  beforeDispatch?: () => Promise<void>
  requireExactOrigin?: boolean
  beforeContextDispatch?: ConversationContextDispatchObserver
  prepareContextDispatch?: (signal?: AbortSignal) => Promise<void>
  acquireAborts?: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  deliveryOrder?: StructuredAgentSessionDeliveryOrder
  workChanged?: () => void
  /** A message the agent took: a chat keeps, where it has none saved, the options it ran. */
  recordRanOptions?: ReturnType<StructuredAgentSessionRanRecorder>
}

/** A handover whose pending row and abort handle are committed: the provider call runs outside the
 *  session's serialize and answers with the commit that resolves it. */
export type StructuredAgentSessionPendingHandover = {
  dispatch: () => Promise<() => Promise<void>>
  release?: () => void
}

type HandoverDispatchResult = {
  outcome: AgentSessionDispatchOutcome | null
  noUserTurnWriteProofReason?: ConversationNoUserTurnWriteReason
}

/**
 * Hands one queued submission to the provider. The `dispatch{pending}` row goes first: a crash
 * after it leaves a message in doubt, never one that reads as queued and so provably unwritten.
 * The abort handle a Stop reaches the call by is begun before that row, in the same step, so no
 * Stop falls between them. Null when the handover finished in this step (a command, a lost body).
 */
export async function beginSubmissionHandover(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission,
  /** Whether the child the row was written for is still the one to call. */
  stillCurrent: () => boolean
): Promise<StructuredAgentSessionPendingHandover | null> {
  const { clientMessageId } = submission
  const body = ctx.journal.itemBody(agentJournalSubmissionKey(clientMessageId))
  if (body?.kind !== 'message') {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('hostFault'), { surface: 'rejection' }),
      fence: ctx.fence
    })
    return null
  }
  if (body.command) {
    await whileStructuredAgentSessionHandingOver(
      ctx.journal,
      clientMessageId,
      async () => handOverStructuredAgentSessionCommand(ctx, submission, body),
      ctx.workChanged
    )
    return null
  }
  // The message joins the turn the child it goes to is running, a steer, or opens its own; never a
  // turn an ended generation left. A new turn carries the stopped messages owed to the agent, named
  // on this same row before anything is written.
  const turnScope = contextStructuredAgentSessionCurrentWork(ctx).turnScope()
  const carried = carriedStoppedHistory(ctx, turnScope, submission, body)
  const release = ctx.deliveryOrder?.activateSend(ctx.sessionId, clientMessageId)
  // The pending row precedes the adapter's own report of which sends it holds.
  const released = beginStructuredAgentSessionHandover(
    ctx.journal,
    clientMessageId,
    ctx.workChanged
  )
  const attempt = ctx.acquireAborts?.begin(ctx.sessionId, true)
  const queued = submission.queuedMessageId !== undefined
  const noWrite = createConversationTransferNoWriteRecorder({
    targetSessionId: ctx.sessionId,
    targetSubmissionId: clientMessageId,
    targetSubmissionSequence: submission.submittedSequence,
    targetFingerprint: submission.payloadFingerprint,
    runtimeFence: ctx.fence
  })
  try {
    await ctx.journal.resolveDispatch(
      {
        clientMessageId,
        state: 'pending',
        fence: ctx.fence,
        turnScope,
        ...(carried ? { carries: carried.covers } : {})
      },
      undefined,
      noWrite.handoverReceipt
    )
  } catch (error) {
    released()
    release?.()
    attempt?.end()
    throw error
  }
  // The handover row's instant on the host clock; the turn this dispatch opens records it so the
  // live counter never re-anchors at turn-open.
  const requestedAt = structuredAgentSessionHandoverOrigin(ctx.journal, submission)
  return {
    release: () => {
      released()
      release?.()
    },
    dispatch: async () => {
      let result: HandoverDispatchResult
      try {
        // Aborted before the call, Orca still held it: a queued card waits again.
        result = attempt?.signal.aborted
          ? {
              outcome: cancelledDispatch(queued),
              noUserTurnWriteProofReason: 'aborted-before-call'
            }
          : // A child gone since the row: its end settles the row, and nothing reaches the wire.
            stillCurrent()
            ? await dispatchSafely(
                ctx,
                clientMessageId,
                carried ? withStoppedHistory(body, carried.messages) : body,
                requestedAt,
                submission.options,
                queued,
                attempt?.signal
              )
            : { outcome: null }
      } finally {
        attempt?.end()
      }
      return async () => {
        const { outcome, noUserTurnWriteProofReason } = result
        await resolveHandover(
          ctx,
          clientMessageId,
          outcome,
          noUserTurnWriteProofReason
            ? noWrite.rejectionReceipt(noUserTurnWriteProofReason)
            : undefined
        )
        if (outcome?.state === 'accepted' || outcome?.state === 'admitted') {
          await ctx.recordRanOptions?.({
            message: submission.options,
            executed: outcome.ranOptions
          })
        }
      }
    }
  }
}

async function resolveHandover(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  outcome: AgentSessionDispatchOutcome | null,
  noWriteReceipt?: JournalOperationReceipt
): Promise<void> {
  // An admission needs no dispatch row: the submission is already pending.
  if (!outcome || outcome.state === 'admitted') {
    return
  }
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            ...(outcome.originCorrelation === 'exact'
              ? { originCorrelation: 'exact' as const }
              : {}),
            fence: ctx.fence
          }
        : outcome.state === 'rejected'
          ? {
              clientMessageId,
              state: 'rejected',
              reason: outcome.reason,
              rejection: outcome.rejection,
              ...(outcome.answeredInTurn ? { answeredInTurn: outcome.answeredInTurn } : {}),
              fence: ctx.fence
            }
          : { clientMessageId, state: 'unknown', reason: outcome.reason, fence: ctx.fence },
      undefined,
      outcome.state === 'rejected' ? noWriteReceipt : undefined
    )
  } catch (error) {
    // A failed resolution must not strand a pending row; an unknown result is
    // explicitly replayable.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: DISPATCH_DOUBT_PERSISTENCE_FAILED,
        fence: ctx.fence
      })
    } catch {
      // Nothing further to record; the pending row is settled on the next open.
    }
    throw error
  }
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles as `unknown`, never
 *  replayed. Only a child that proved its start is handed anything, so a start that fails leaves its
 *  messages unsent instead (the delivery loop's barrier); an adapter that knows a write never
 *  happened answers `rejected`. */
async function dispatchSafely(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  requestedAt: number,
  executionOptions: AgentSessionExecutionOptions | undefined,
  queued: boolean,
  signal?: AbortSignal
): Promise<HandoverDispatchResult> {
  let completedNativeObservation = false
  let adapterInvoked = false
  try {
    await ctx.prepareContextDispatch?.(signal)
    signal?.throwIfAborted()
    adapterInvoked = true
    const outcome = await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      ...(executionOptions ? { executionOptions } : {}),
      ...(signal ? { signal } : {}),
      fence: ctx.fence,
      requestedAt,
      beforeDispatch: ctx.beforeDispatch,
      ...(ctx.requireExactOrigin ? { requireExactOrigin: true as const } : {}),
      beforeContextDispatch: ctx.beforeContextDispatch
        ? async (observation) => {
            await ctx.beforeContextDispatch?.(observation, signal)
            if (!signal?.aborted) {
              completedNativeObservation = true
            }
          }
        : undefined,
      onInputPreparation: ctx.recordRanOptions?.prepareInput,
      onExecutionSnapshot: ctx.recordRanOptions?.checkpoint
    })
    // The agent's own answer stands, aborted or not.
    return { outcome }
  } catch (error) {
    const guaranteedPreWrite =
      !adapterInvoked || (ctx.beforeContextDispatch !== undefined && !completedNativeObservation)
    if (error instanceof AgentSessionPreDispatchError) {
      // Only the user-turn write is proven absent; provider option preparation may have run.
      return {
        outcome: cancelledDispatch(queued),
        ...(guaranteedPreWrite
          ? { noUserTurnWriteProofReason: 'pre-dispatch-refusal' as const }
          : {})
      }
    }
    // Exact signal identity preserves cancellation; an earlier native observation still vetoes proof.
    if (isAbortSignalReason(signal, error)) {
      return {
        outcome: cancelledDispatch(queued),
        ...(guaranteedPreWrite ? { noUserTurnWriteProofReason: 'pre-write-abort' as const } : {})
      }
    }
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        outcome: {
          state: 'rejected',
          ...agentSessionFailureWords(
            agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
            { surface: 'rejection' }
          )
        }
      }
    }
    return {
      outcome: { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Only a queued card's hand-off records the proof; on a direct send it would owe the message as
 *  stopped history. */
function cancelledDispatch(neverReachedAgent: boolean): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('cancelled', neverReachedAgent ? { neverReachedAgent } : {}),
      { surface: 'rejection' }
    )
  }
}
