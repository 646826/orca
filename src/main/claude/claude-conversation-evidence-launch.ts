import { conversationEvidencePreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-evidence-launch-error'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir, claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import type { ClaudeSession } from './claude-structured-session-state'
import { claudeConversationCapabilities } from './claude-conversation-capabilities'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { conversationContextDigest } from '../native-chat/conversations/conversation-context-consent'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeAcquisitionLaunch } from './claude-structured-acquisition-launch'
export function prepareClaudeConversationEvidence(
  input: StructuredAgentSessionAcquireInput,
  launch: ClaudeAcquisitionLaunch
) {
  if (!input.evidenceLaunch) {
    return null
  }
  const selected = {
    ...launch.env,
    ...claudeConfigDirEnvPatch(launch.claudeConfigDir, launch.env ? { env: launch.env } : {})
  }
  const effectiveEnv = buildClaudeChildProcessEnv(selected, {
    inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
    scrubConfiguredChildSessionStamps: true
  })
  for (const key of launch.envToDelete ?? []) {
    delete effectiveEnv[key]
  }
  const { [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: _token, ...env } = effectiveEnv
  const { sessionId: _freshId, ...options } = launch.options
  const launchFingerprint = conversationContextDigest({
    command: launch.pathToClaudeCodeExecutable,
    cwd: launch.cwd,
    claudeConfigDir: launch.claudeConfigDir,
    options,
    selectedOptions: Object.fromEntries(launch.savedOptions.options),
    fastModeAtStart: launch.savedOptions.fastModeAtStart,
    env,
    envToDelete: launch.envToDelete ?? [],
    version: launch.contextDeliveryVersion ?? null
  })
  try {
    const permit = input.evidenceLaunch.observe({
      launchFingerprint,
      transport: 'claude-sdk-mcp',
      resuming: launch.resumesTranscript
    })
    permit.assertBeforeSpawn()
    return { permit, launchFingerprint, effectiveEnv }
  } catch (error) {
    throw conversationEvidencePreSpawnError(error)
  }
}

export async function confirmClaudeConversationEvidence(
  session: ClaudeSession,
  signal: AbortSignal
) {
  const evidence = session.conversationEvidence
  if (!evidence || evidence.confirmed) {
    return
  }
  signal.throwIfAborted()
  if (
    !session.connection.evidenceToolRegistered ||
    !(await waitForPromiseWithSignal(session.connection.evidenceToolRegistered(), signal))
  ) {
    throw new Error('Claude conversation evidence tool registration is unverified')
  }
  signal.throwIfAborted()
  evidence.permit.assertBeforeSpawn()
  const capabilities = claudeConversationCapabilities(session)
  if (capabilities.state !== 'verified') {
    throw new Error('Claude evidence acquisition capability is unverified')
  }
  evidence.permit.registration.confirm({
    nativeSessionId: session.providerSessionId,
    acquisitionGeneration: session.acquisitionGeneration,
    runtimeFence: session.fence,
    baseCapabilityFingerprint: capabilities.runtimeFingerprint,
    launchFingerprint: evidence.launchFingerprint,
    transport: 'claude-sdk-mcp'
  })
  evidence.confirmed = true
}

export function claudeEvidenceConnectionLaunch(
  launch: ClaudeAcquisitionLaunch,
  evidence: ReturnType<typeof prepareClaudeConversationEvidence>
) {
  return {
    ...(evidence ? { evidence: evidence.permit, evidenceEnv: evidence.effectiveEnv } : {}),
    pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
    options: launch.options,
    cwd: launch.cwd,
    env: {
      ...launch.env,
      ...claudeConfigDirEnvPatch(launch.claudeConfigDir, launch.env ? { env: launch.env } : {})
    },
    ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {})
  }
}
