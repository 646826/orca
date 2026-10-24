import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import type { AgentSessionCreatePhaseRecorder } from '../../observability/agent-session-instrumentation'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'

export type StructuredAgentSessionAttachOptions = {
  /** Host-owned originating switch; never supplied by RPC payloads. */
  expectedConversationOperationKey?: string | null
  conversationMutationSupported?: boolean
  hostLaunchDirectory?: string
  /** The saved list a new chat's options are admitted against, for the folder its picker read. */
  catalogModels?: AttachFlowInput['models']
  recordPhase?: AgentSessionCreatePhaseRecorder
  onAcquisitionFailed?: AttachFlowInput['onAcquisitionFailed']
  /** The queued message a start is for; see `StructuredAgentSessionProviderChild.startedFor`. */
  startedFor?: string
  startupOptions?: Readonly<Record<string, string>>
  /** A close, an admitted Stop or quit aborted this attach: its refusal is that abort's. */
  onAborted?: () => void
  /** The startup limit aborted this attach's acquire: it failed, nobody stopped it. */
  onStartupExpired?: () => void
  /** An agent start's: its steps run outside the session's serialize and commit under it. */
  lock?: StructuredAgentSessionAttachLock
  startupAttemptId?: string
  /** The attach made its child the session's. */
  onPublished?: () => void
}
