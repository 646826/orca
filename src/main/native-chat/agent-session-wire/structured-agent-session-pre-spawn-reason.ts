import type { AgentSessionRefusalReason } from '../../../shared/agent-session-refusal-details'

export type AgentSessionPreSpawnReason = Extract<
  AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  | 'managedAccountEnvOverride'
  | 'accountSwitchInProgress'
  | 'managedAccountUnsupported'
  | 'launchFolderMissing'
  | 'historyInOtherAccount'
  | 'claudeAccountFolderMissing'
  | 'claudeAccountSetupFailed'
  | 'agentCommandNotRunnable'
  | 'runtimeNotInstalled'
  | 'conversationStartupTrustRequired'
  | 'conversationNativeRebuildRequired'
>
