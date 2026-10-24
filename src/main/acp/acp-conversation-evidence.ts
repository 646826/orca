import { conversationContextDigest } from '../native-chat/conversations/conversation-context-consent'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { conversationEvidencePreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-evidence-launch-error'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ConversationEvidenceLaunchPermit } from '../native-chat/conversations/conversation-evidence-registration'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { createAcpConversationEvidenceServer } from './acp-conversation-evidence-server'
import type { InitializeResponse } from './generated/acp-protocol.generated'

export type AcpConversationEvidence = {
  permit: ConversationEvidenceLaunchPermit
  launchFingerprint: string
  server?: Awaited<ReturnType<typeof createAcpConversationEvidenceServer>>
  closed: boolean
  closing?: Promise<void>
}
function fingerprint(launch: AcpStructuredLaunch): string {
  return conversationContextDigest({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    permission: launch.fullAccess ? 'full-access' : 'ask',
    nativeSession: launch.resume?.sessionId ?? null,
    env: Object.fromEntries(
      Object.entries(resolveProviderChildEnv(launch, process.env)).filter(
        ([key, value]) => value !== undefined && key !== 'ORCA_AGENT_SESSION_SPAWN_TOKEN'
      )
    )
  })
}
export function prepareAcpConversationEvidence(
  acquire: StructuredAgentSessionAcquireInput,
  launch: AcpStructuredLaunch
): AcpConversationEvidence | undefined {
  if (!acquire.evidenceLaunch) {
    return undefined
  }
  let permit: ConversationEvidenceLaunchPermit | undefined
  try {
    acquire.signal?.throwIfAborted()
    const launchFingerprint = fingerprint(launch)
    permit = acquire.evidenceLaunch.observe({
      launchFingerprint,
      transport: 'acp-http-mcp',
      resuming: launch.resume !== null
    })
    permit.assertBeforeSpawn()
    return { permit, launchFingerprint, closed: false }
  } catch (error) {
    void permit?.registration.close().catch(() => {
      console.warn('[acp] conversation evidence cleanup failed')
    })
    throw conversationEvidencePreSpawnError(error)
  }
}
export function assertAcpEvidenceBeforeSpawn(
  evidence: AcpConversationEvidence,
  launch: AcpStructuredLaunch
): void {
  try {
    if (evidence.closed || fingerprint(launch) !== evidence.launchFingerprint) {
      throw new Error('ACP evidence launch changed')
    }
    evidence.permit.assertBeforeSpawn()
  } catch (error) {
    throw conversationEvidencePreSpawnError(error)
  }
}
export async function startAcpEvidenceServer(
  evidence: AcpConversationEvidence,
  initialized: InitializeResponse,
  agent: string
) {
  if (
    agent !== 'opencode' ||
    initialized.protocolVersion !== 1 ||
    initialized.agentInfo?.version !== '1.19.4' ||
    initialized.agentCapabilities?.mcpCapabilities?.http !== true
  ) {
    throw new Error('ACP conversation evidence transport is unverified')
  }
  if (evidence.closed) {
    throw new Error('ACP evidence owner closed')
  }
  const server = await createAcpConversationEvidenceServer(evidence.permit.registration)
  evidence.server = server
  if (evidence.closed) {
    await server.close()
    throw new Error('ACP evidence owner closed')
  }
  return server.descriptor
}
export function closeAcpConversationEvidence(
  evidence: AcpConversationEvidence | undefined
): Promise<void> {
  if (!evidence) {
    return Promise.resolve()
  }
  if (evidence.closing) {
    return evidence.closing
  }
  evidence.closed = true
  evidence.closing = evidence.server
    ? evidence.server.close()
    : evidence.permit.registration.close()
  return evidence.closing
}
