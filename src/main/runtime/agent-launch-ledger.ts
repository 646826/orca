import { deriveAgentLaunchChildOperationId } from '../../shared/agent-launch-operation'
import { isAgentLaunchResult, type AgentLaunchResult } from '../../shared/agent-launch-intent'
import type {
  AgentSessionOperationOutcome,
  AgentSessionOperationRefusalCode
} from '../../shared/agent-session-operation-ledger'
import { resolveAgentSessionReplayOutcome } from '../native-chat/agent-session-wire/structured-agent-session-replay-outcome'
import type { AgentSessionRecordStore } from './agent-session-record-store'

export type AgentLaunchRefusal = { code: string; message: string; said?: string }
export type AgentLaunchLedgerIdentity = { callerKey: string; operationId: string }
export type AgentLaunchLedgerAdmission =
  | { decision: 'execute'; attachOperationId: string; callerKey: string }
  | { decision: 'replay'; result: AgentLaunchResult }
  | { decision: 'refuse'; refusal: AgentLaunchRefusal }
export type AgentLaunchLedger = {
  admit(
    input: AgentLaunchLedgerIdentity & { fingerprint: string; now: number }
  ): Promise<AgentLaunchLedgerAdmission>
  record(input: AgentLaunchLedgerIdentity & { result: AgentLaunchResult }): Promise<void>
  fail(input: AgentLaunchLedgerIdentity & { code: string; message?: string }): Promise<void>
  publicationEligibility(input: AgentLaunchLedgerIdentity): Promise<'recorded' | 'unrecorded'>
}

export class AgentLaunchLedgerOwner implements AgentLaunchLedger {
  private stopped = false
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly store: AgentSessionRecordStore) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new Error('agent_launch_ledger_stopped'))
    }
    // Invoke now: provisional and final settlements must enter the store FIFO in caller order.
    const result = operation()
    this.pending.add(result)
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result)
    )
    return result
  }

  async stopAndDrain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.pending)
  }

  admit(
    input: AgentLaunchLedgerIdentity & { fingerprint: string; now: number }
  ): Promise<AgentLaunchLedgerAdmission> {
    const args = structuredClone(input)
    return this.run(async () => {
      const { operationId, callerKey } = args
      const attachOperationId = deriveAgentLaunchChildOperationId(operationId)
      if (!attachOperationId) {
        return refusal(
          operationId,
          'agent_session_operation_invalid',
          'is not a durable operation id'
        )
      }
      const { decision: admitted, claim } = await this.store.admitAndClaimOperation(
        args,
        (decision) =>
          decision.decision === 'admit' ||
          (decision.decision === 'replay' &&
            answerFromRecordedRow(operationId, decision.row.outcome) === null)
      )
      if (admitted.decision === 'refused') {
        return refusal(operationId, admitted.code, `was refused: ${admitted.code}`)
      }
      if (admitted.decision === 'replay') {
        const answer = answerFromRecordedRow(operationId, admitted.row.outcome)
        if (answer) {
          return structuredClone(answer)
        }
      }
      if (!claim || claim.claim === 'absent') {
        return refusal(
          operationId,
          'agent_session_operation_unknown',
          'has no claim; its outcome is unknown'
        )
      }
      if (claim.claim === 'lost') {
        return structuredClone(
          answerFromRecordedRow(operationId, claim.row.outcome) ??
            refusal(operationId, 'agent_session_operation_unknown', 'is claimed but unsettled')
        )
      }
      return { decision: 'execute', callerKey, attachOperationId }
    })
  }

  record(input: AgentLaunchLedgerIdentity & { result: AgentLaunchResult }): Promise<void> {
    const { callerKey, operationId, result } = structuredClone(input)
    return this.run(() =>
      this.store.recordOperationOutcome({
        callerKey,
        operationId,
        outcome: {
          status: 'succeeded',
          sessionId: result.outcome.kind === 'structured' ? result.outcome.sessionId : '',
          launch: result
        }
      })
    )
  }

  fail(input: AgentLaunchLedgerIdentity & { code: string; message?: string }): Promise<void> {
    const { callerKey, operationId, code, message } = structuredClone(input)
    return this.run(() =>
      this.store.recordOperationOutcome({
        callerKey,
        operationId,
        outcome: {
          status: 'failed',
          code,
          ...(message ? { message } : {})
        }
      })
    )
  }

  publicationEligibility(input: AgentLaunchLedgerIdentity): Promise<'recorded' | 'unrecorded'> {
    const { callerKey, operationId } = structuredClone(input)
    return this.run(async () =>
      (await this.store.hasOperationInOrder(callerKey, operationId)) ? 'recorded' : 'unrecorded'
    )
  }
}

function answerFromRecordedRow(
  operationId: string,
  outcome: AgentSessionOperationOutcome
): AgentLaunchLedgerAdmission | null {
  if (outcome.status === 'failed') {
    // Replayed verbatim rather than narrowed to the `agentSession.*` vocabulary. A launch fails
    // with its own codes — `worktree_not_found` and the reuse-terminal guards — none of which is on
    // that closed list, so narrowing would answer every one of them with
    // `agent_session_operation_invalid`: the ledger's "your id is malformed" signal. The original
    // code says this launch definitively failed; the same id replays that answer, while a deliberate
    // new attempt must use a fresh id.
    return {
      decision: 'refuse',
      refusal: {
        code: outcome.code,
        message:
          outcome.message ?? `Launch operation ${operationId} already failed: ${outcome.code}.`,
        ...(outcome.message ? { said: outcome.message } : {})
      }
    }
  }
  const replay = resolveAgentSessionReplayOutcome<AgentLaunchResult>({
    operationId,
    outcome,
    // Narrowed here rather than in the row validator: a launch payload this build cannot read must
    // cost this one replay, not the whole store. `isAgentSessionOperationRow` says why.
    reconstruct: () =>
      outcome.status === 'succeeded' && isAgentLaunchResult(outcome.launch) ? outcome.launch : null
  })
  if (replay.decision === 'rerun') {
    return null
  }
  return replay.decision === 'replay'
    ? { decision: 'replay', result: replay.value }
    : { decision: 'refuse', refusal: replay.refusal }
}

function refusal(
  operationId: string,
  code: AgentSessionOperationRefusalCode | 'agent_session_operation_unknown',
  detail: string
): AgentLaunchLedgerAdmission {
  return {
    decision: 'refuse',
    refusal: { code, message: `Launch operation ${operationId} ${detail}.` }
  }
}
