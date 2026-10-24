import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { structuredAgentSessionHandingOver } from './structured-agent-session-handing-over'

export type ConversationQuiescenceBlocker =
  | 'unopened'
  | 'owner-unverifiable'
  | 'foreground-work'
  | 'unsettled-submission'
  | 'pending-prompts'
  | 'provider-holds-dispatch'
  | 'handing-over'
  | 'starting'
  | 'stopping'
  | 'background-work'
  | 'background-incomplete'
  | 'supervised-work'

export type ConversationQuiescenceSnapshot = {
  ready: boolean
  blockers: ConversationQuiescenceBlocker[]
  cursor: AgentJournalCursor | null
  runtimeFence: number | null
  /** A conversation fence cannot fence another session or an external process. */
  externalWorkspaceWriters: 'unknown'
}

export type ConversationQuiescenceHost = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'replacedRuntime'>
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: Pick<StructuredAgentSessionAdapter, 'holdsDispatch'>
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  childWorkIncomplete: (sessionId: string) => boolean
  starting: (sessionId: string) => boolean
  stopping: (sessionId: string) => boolean
  hasOpenDispatch: (record: AgentSessionRecord) => boolean
}

/** Read in a short session phase. Never waits for the events/settlement that need that queue.
 * A ready snapshot is not an activation token: the coordinator must still compare source revisions. */
export function readStructuredConversationQuiescence(
  host: ConversationQuiescenceHost,
  sessionId: string
): ConversationQuiescenceSnapshot {
  const session = host.sessions.get(sessionId)
  const record = host.store.getRecord(sessionId)
  const blockers: ConversationQuiescenceBlocker[] = []
  const add = (condition: boolean, blocker: ConversationQuiescenceBlocker) => {
    if (condition) {
      blockers.push(blocker)
    }
  }
  add(!session || !record, 'unopened')
  if (session && record) {
    const work = hostStructuredAgentSessionCurrentWork(host, sessionId)
    add(
      record.lease.unreconciled ||
        record.lease.claimStatus === 'conflicted' ||
        record.lease.handoffStage === 'recovering',
      'owner-unverifiable'
    )
    add(work?.working() === true, 'foreground-work')
    // Unlike the UI's working projection, include unanswered dispatches released by the provider
    // and older fences. Neither an idle report nor provider release proves their outcome.
    add(
      session.journal
        .submissions()
        .some((entry) => entry.dispatchState === 'pending' || entry.dispatchState === 'unknown'),
      'unsettled-submission'
    )
    add(work?.hasActionablePrompt() === true, 'pending-prompts')
    add(structuredAgentSessionHandingOver(session.journal).size > 0, 'handing-over')
    add(host.adapter.holdsDispatch?.(sessionId) === true, 'provider-holds-dispatch')
    add(host.hasOpenDispatch(record), 'supervised-work')
  }
  add(host.starting(sessionId) || session?.child?.phase === 'starting', 'starting')
  add(host.stopping(sessionId) || session?.child?.close !== undefined, 'stopping')
  add(host.childWorkIncomplete(sessionId), 'background-incomplete')
  add(
    host.childWorkOpen(sessionId) ||
      (host.readChildWork(sessionId) ?? []).some(
        (child) => child.membership === 'live' && child.state !== 'done'
      ),
    'background-work'
  )
  return {
    ready: blockers.length === 0,
    blockers,
    cursor: session?.journal.cursor() ?? null,
    runtimeFence: record?.lease.runtimeFence ?? null,
    externalWorkspaceWriters: 'unknown'
  }
}
