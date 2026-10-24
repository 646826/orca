import {
  nativeConversationCapabilities,
  nativeConversationReportedOptions
} from '../native-chat/conversations/conversation-native-capabilities'
import type { CodexSession } from './codex-structured-session-state'
export function codexConversationCapabilities(session: CodexSession | undefined) {
  const observation = session?.contextDeliveryObservation
  return nativeConversationCapabilities(
    session && observation
      ? {
          ...observation,
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration,
          nativeSessionId: session.threadId,
          closed: session.ended || !!session.orcaClose || session.connection.closed,
          options: {
            ...nativeConversationReportedOptions(
              observation,
              Object.fromEntries(
                Object.entries(session.reportedOptions).filter(
                  (entry): entry is [string, string] => typeof entry[1] === 'string'
                )
              )
            ),
            ...Object.fromEntries(session.options)
          }
        }
      : null
  )
}
