import { readAgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { acpMessageOptionWrites } from './acp-message-execution-options'
import {
  nativeConversationCapabilities,
  nativeConversationReportedOptions
} from '../native-chat/conversations/conversation-native-capabilities'
import { isAcpReadySession, type AcpStructuredChild } from './acp-structured-child'
export function acpConversationCapabilities(session: AcpStructuredChild | undefined) {
  const observation = session?.contextDeliveryObservation
  return nativeConversationCapabilities(
    isAcpReadySession(session) && observation
      ? {
          ...observation,
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration,
          closed:
            session.ended ||
            session.closeRequested ||
            session.journalClosed !== null ||
            session.connection.closed ||
            session.connection.exited,
          options: {
            ...nativeConversationReportedOptions(observation, {
              ...session.options.contextDeliveryChoices(),
              ...session.options.reported()
            }),
            mutation: String(session.options.writeRevision)
          }
        }
      : null
  )
}

export function projectAcpSessionOptions(
  session: AcpStructuredChild | undefined,
  requested: Readonly<Record<string, string>>
) {
  if (
    !isAcpReadySession(session) ||
    session.ended ||
    session.closeRequested ||
    session.journalClosed !== null ||
    session.connection.closed ||
    session.connection.exited
  ) {
    return undefined
  }
  const execution = readAgentSessionExecutionOptions(requested)
  if (!execution) {
    return undefined
  }
  try {
    if (acpMessageOptionWrites(session.options, execution).next().done !== true) {
      return undefined
    }
  } catch (error) {
    if (error instanceof AgentSessionOptionRejectedError) {
      return undefined
    }
    throw error
  }
  return {
    models: session.options.read().models,
    options: Object.fromEntries(
      Object.entries(session.options.reported()).filter(([key]) =>
        session.options.currentProof.has(key)
      )
    )
  }
}

export function readAcpSessionCommands(session: AcpStructuredChild | undefined) {
  return session && isAcpReadySession(session) ? session.options.readCommands() : undefined
}
