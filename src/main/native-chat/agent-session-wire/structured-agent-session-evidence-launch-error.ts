import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
import { ConversationEvidenceStartupTrustRequiredError } from '../conversations/conversation-evidence-launch-gate'
import { AgentSessionPreSpawnError } from './structured-agent-session-adapter'

/** Only callers before native spawn may turn a launch choice into processless proof. */
export function conversationEvidencePreSpawnError(error: unknown): AgentSessionPreSpawnError {
  const reason =
    error instanceof ConversationEvidenceStartupTrustRequiredError
      ? 'conversationStartupTrustRequired'
      : error instanceof ConversationRpcRefusal && error.reason === 'native-rebuild-required'
        ? 'conversationNativeRebuildRequired'
        : undefined
  return new AgentSessionPreSpawnError(error, reason ? { reason } : {})
}
