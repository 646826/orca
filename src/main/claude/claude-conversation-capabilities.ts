import { readClaudeCapabilities } from './claude-structured-init-proof'
import type { ClaudeAcquisitionLaunch } from './claude-structured-acquisition-launch'
import {
  nativeConversationCapabilities,
  nativeConversationReportedOptions
} from '../native-chat/conversations/conversation-native-capabilities'
import type { ClaudeSession } from './claude-structured-session-state'
export function claudeConversationCapabilities(session: ClaudeSession | undefined) {
  const observation = session?.contextDeliveryObservation
  if (
    !session ||
    !observation ||
    session.connection.closed ||
    session.closeFinalization ||
    session.closeEnded
  ) {
    return nativeConversationCapabilities(null)
  }
  // Failed initialization has no usable contract. This reads only the captured proof.
  try {
    session.initialization.proof.seen()
  } catch {
    return nativeConversationCapabilities(null)
  }
  return nativeConversationCapabilities({
    ...observation,
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    initialized: observation.initialized,
    nativeSessionId: session.providerSessionId,
    options: {
      ...nativeConversationReportedOptions(
        observation,
        Object.fromEntries(
          Object.entries(session.reportedOptions).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      ),
      ...Object.fromEntries(session.options),
      mutation: String(session.optionMutationSequence)
    }
  })
}

/** Capture the resolved launch before publication; control-open establishes readiness later. */
export function initializeClaudeConversationObservation(
  session: ClaudeSession,
  launch: ClaudeAcquisitionLaunch
): void {
  const observedVersion = session.initialization.proof.seen()?.message.claude_code_version
  session.contextDeliveryObservation = {
    agent: 'claude',
    protocol: 'claude-sdk-stream',
    version:
      typeof observedVersion === 'string'
        ? observedVersion
        : (launch.contextDeliveryVersion ?? null),
    nativeSessionId: session.providerSessionId,
    acquisitionGeneration: session.acquisitionGeneration,
    fence: session.fence,
    launch: {
      command: launch.pathToClaudeCodeExecutable,
      cwd: launch.cwd,
      permission: JSON.stringify({
        mode: launch.options.permissionMode ?? null,
        fullAccess: Object.hasOwn(launch.options.extraArgs ?? {}, 'dangerously-skip-permissions')
      })
    },
    options: {},
    initialized: false,
    closed: false,
    resume: true
  }
}

export function observeClaudeConversationInitialization(
  session: ClaudeSession,
  message: Record<string, unknown>
): void {
  session.capabilities = readClaudeCapabilities(session.capabilities, message)
  if (session.contextDeliveryObservation && typeof message.claude_code_version === 'string') {
    session.contextDeliveryObservation.version = message.claude_code_version
  }
}
