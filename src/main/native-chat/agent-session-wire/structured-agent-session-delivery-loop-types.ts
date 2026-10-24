import type { ConversationContextDispatchObserver } from './structured-conversation-context-dispatch'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionStartClaim } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionStartReadiness } from './structured-agent-session-startup-attempt'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { StructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'

export type StructuredAgentSessionDeliveryLoopDeps = {
  requiresExactOrigin: (sessionId: string, submissionId: string) => boolean
  prepareContextDispatch?: (
    sessionId: string,
    submissionId: string,
    signal?: AbortSignal
  ) => Promise<void>
  contextDispatch: (sessionId: string, submissionId: string) => ConversationContextDispatchObserver
  canDispatch: (sessionId: string, submission: AgentJournalSubmission) => boolean
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A start step, tracked from enqueue so quit waits for the child it may produce. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  /** Claims the start for the queued head inside the ordered preparation. */
  startProviderChild: (sessionId: string, startedFor: string) => StructuredAgentSessionStartClaim
  /** Stops a child the chat outgrew (a new login or permission mode); inside `serialize`. */
  retireOutgrownChild: (sessionId: string) => Promise<void>
  readiness: (
    sessionId: string,
    child: StructuredAgentSessionProviderChildIdentity
  ) => StructuredAgentSessionStartReadiness | null
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** A close of this chat that stopped its child and then did not complete still closed what was
   *  queued before it, so no child starts for those: settled as a completed close does. Ordered,
   *  not latched: a later send goes on. False when those could not be closed. */
  closeWhatTheUserClosed: (sessionId: string) => Promise<boolean>
  /** Who the chat's failure sentences name. */
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  /** The host's projection of the chat's current work (`hostStructuredAgentSessionCurrentWork`). */
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
  /** What is current changed with no row (`publishGenerationEnded`). */
  workChanged?: (sessionId: string) => void
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  childWorkOpen: (sessionId: string) => boolean
  /** A person's Stop is still ending the session's work: the status feed's own reading. */
  stopping: (sessionId: string) => boolean
  now: () => number
  acquireAborts: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  recordRanOptions?: StructuredAgentSessionRanRecorder
}
