import type { ConversationEvidenceLaunchCapture } from '../conversations/conversation-evidence-registration'

export type CaptureConversationEvidenceLaunch = (
  sessionId: string,
  fence: number,
  signal: AbortSignal | undefined,
  expectedOperationKey: string | null
) => ConversationEvidenceLaunchCapture | undefined
