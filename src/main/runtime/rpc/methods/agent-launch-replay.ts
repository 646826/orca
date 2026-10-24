/**
 * Durable admission for `agent.launch`.
 *
 * The contract this enforces is three sentences: an operation runs at most once, a replay returns
 * the recorded answer, and an operation whose outcome is unknown is refused. Everything else a lost
 * launch might want — finding the workspace a dead attempt left behind, adopting a half-created
 * session, finishing an interrupted publication — is recovery, and none of it is here. Recovery
 * makes a stranded user whole; this makes a retry harmless, and the two are bought separately.
 *
 * The order is the inverse of what the handler did before. Admission comes first, ahead of
 * resolving the caller's worktree selector, because a selector resolution is a live precondition
 * and a replay must not be able to fail on one: an operation that already ran has an answer, and
 * re-deciding it against today's world is how a recorded success becomes a fresh refusal the client
 * then retries as a second effect. `admitAgentSessionMutation` puts the ledger ahead of the writer
 * lease for that same reason.
 */

import { deriveAgentLaunchChildOperationId } from '../../../../shared/agent-launch-operation'
import {
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY
} from '../../../../shared/agent-launch-runtime-capability'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../../shared/agent-launch-tab-closed'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { AgentSessionOperationRefusalCode } from '../../../../shared/agent-session-operation-ledger'
import type { AgentLaunchRefusal } from '../../agent-launch-ledger'
export type { AgentLaunchRefusal } from '../../agent-launch-ledger'
import type { RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import { agentLaunchFailureMessage } from './agent-launch-failure-code'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'

/**
 * The ledger namespace of whoever the transport says is calling. A transport that could not name its
 * caller gets no replay safety at all, rather than a namespace shared with strangers.
 */
export function agentLaunchOperationCallerKey(context: Pick<RpcContext, 'caller'>): string {
  if (!context.caller) {
    throw new Error('agent_session_identity_required')
  }
  return rpcCallerOperationKey(context.caller)
}

/**
 * `agent.launch` raises its refusals as the thrown code, the way the method's own guards do, so a
 * refusal here carries whatever code the operation recorded rather than the closed `agentSession.*`
 * envelope. An `AgentSessionWireRefusal` still fits, which is how the shared replay resolver's
 * answers pass through unchanged. `said` is the words a failed launch was refused with, for its
 * replay to repeat.
 */

export type AgentLaunchAdmission =
  /** This caller owns the operation. It alone runs the effect, and it must settle the row. */
  | {
      decision: 'execute'
      /** The surface exists: records the launch as it stands, so a restart before `settle` replays
       *  the running agent instead of refusing an unknown outcome. */
      record: (provisional: AgentLaunchResult) => Promise<void>
      settle: (result: AgentLaunchResult) => Promise<void>
      /** `cause` is the refusal, whose own words a coded one keeps for its replay. */
      fail: (code: string, cause?: unknown) => Promise<void>
      /** Distinct from the launch id: the inner attach reserves in this same ledger. */
      attachOperationId: string
      callerKey: string
    }
  /** Already run under this id; hand back what it produced rather than producing it again. */
  | { decision: 'replay'; result: AgentLaunchResult }
  | { decision: 'refuse'; refusal: AgentLaunchRefusal }

/** A launch whose tab the user closed answers with its own word only to a caller that reads it. */
export function readsAgentLaunchTabClosed(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY) === true
  )
}

/** The CLI (no declared client) ships with this host; any other caller must say it reads the word. */
function readsUnconfirmedLaunchPrompt(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY) ===
      true
  )
}

/**
 * The handle this runtime uses for the recorded pane now. Usually that is the recorded handle: the
 * daemon and the SSH relay keep each PTY's handle, and a restarted runtime re-adopts it. It does not
 * when the PTY's incarnation changed, when it already issued that pane another handle before reading
 * the inventory, or when the PTY stored none; the pane key, the durable name, finds it then. A pane
 * this runtime no longer knows keeps the recorded handle, which reads as an exited terminal — the
 * truth about one that is gone. The handle stays because shipped clients require one.
 */
function withLiveTerminalHandle(
  recorded: AgentLaunchResult,
  runtime: Pick<RpcContext['runtime'], 'getTerminalHandleForPaneKey'>
): AgentLaunchResult {
  const { outcome } = recorded
  if (outcome.kind !== 'terminal' || !outcome.paneKey) {
    return recorded
  }
  const handle = runtime.getTerminalHandleForPaneKey(outcome.paneKey)
  return handle && handle !== outcome.handle
    ? { ...recorded, outcome: { ...outcome, handle } }
    : recorded
}

/**
 * A recorded answer as this caller may read it now. A prompt the host stopped delivering is
 * `unconfirmed` only to a caller that reads the word; every other caller gets the refusal it got
 * before the first write existed, never a `not-delivered` that invites a duplicate turn.
 */
function presentRecordedAnswer(
  context: RpcContext,
  operationId: string,
  answer: AgentLaunchAdmission
): AgentLaunchAdmission {
  if (
    answer.decision === 'refuse' &&
    answer.refusal.code === AGENT_LAUNCH_TAB_CLOSED_CODE &&
    !readsAgentLaunchTabClosed(context)
  ) {
    return refusal(
      operationId,
      'agent_session_operation_unknown',
      'was stopped; its tab was closed'
    )
  }
  if (answer.decision !== 'replay') {
    return answer
  }
  if (answer.result.prompt?.outcome === 'unconfirmed' && !readsUnconfirmedLaunchPrompt(context)) {
    return refusal(
      operationId,
      'agent_session_operation_unknown',
      'started its agent, but whether its prompt arrived is unknown'
    )
  }
  return { decision: 'replay', result: withLiveTerminalHandle(answer.result, context.runtime) }
}

/**
 * Admit, then claim, in one durable transaction so a launch writes the ledger once before its effect.
 *
 * Two steps because they answer different questions — "is this id known and consistent?" and "may
 * *I* run it?" — and the second cannot be folded into the first. Admission hands two concurrent
 * replays the same `pending` row; only a conditional swap can tell the one that may run from the
 * one that must replay.
 */
export async function admitAgentLaunchOperation(
  context: RpcContext,
  params: AgentLaunchParams & { operationId: string },
  fingerprint: string,
  now: number = Date.now()
): Promise<AgentLaunchAdmission> {
  const operationId = params.operationId
  const attachOperationId = deriveAgentLaunchChildOperationId(operationId)
  if (!attachOperationId) {
    return refusal(operationId, 'agent_session_operation_invalid', 'is not a durable operation id')
  }
  const callerKey = agentLaunchOperationCallerKey(context)
  const ledger = await context.runtime.openAgentLaunchLedger()
  const admission = await ledger.admit({ callerKey, operationId, fingerprint, now })
  if (admission.decision !== 'execute') {
    return presentRecordedAnswer(context, operationId, admission)
  }
  const succeeded = (result: AgentLaunchResult) => ledger.record({ callerKey, operationId, result })
  return {
    ...admission,
    record: succeeded,
    settle: succeeded,
    fail: (code, cause) => {
      const message = agentLaunchFailureMessage(cause)
      return ledger.fail({ callerKey, operationId, code, ...(message ? { message } : {}) })
    }
  }
}

function refusal(
  operationId: string,
  code: AgentSessionOperationRefusalCode | 'agent_session_operation_unknown',
  detail: string
): AgentLaunchAdmission {
  return {
    decision: 'refuse',
    refusal: { code, message: `Launch operation ${operationId} ${detail}.` }
  }
}
