import type {
  conversationEvidenceToolDefinition,
  ConversationEvidenceTransport
} from './conversation-evidence-tool-contract'

export type ConversationEvidenceNativeOwner = {
  nativeSessionId: string
  acquisitionGeneration: string
  runtimeFence: number
  baseCapabilityFingerprint: string
  launchFingerprint: string
  transport: ConversationEvidenceTransport
}
export type ConversationEvidenceRegistration = {
  registrationId: string
  acquisitionGeneration: string
  nativeSessionId: string
  runtimeFence: number
  capabilityFingerprint: string
  protocol: 'orca-evidence-v1'
  startupTrust: 'approved'
  transport: ConversationEvidenceTransport
}

export type ConversationEvidencePendingRegistration = {
  definition: ReturnType<typeof conversationEvidenceToolDefinition>
  close(): Promise<void>
  confirm(observed: ConversationEvidenceNativeOwner): void
  invoke(raw: unknown, signal: AbortSignal): Promise<unknown>
}
export type ConversationEvidenceLaunchPermit = {
  assertBeforeSpawn(): void
  registration: ConversationEvidencePendingRegistration
}
export type ConversationEvidenceLaunchCapture = {
  observe(input: {
    launchFingerprint: string
    transport: ConversationEvidenceTransport
    resuming: boolean
  }): ConversationEvidenceLaunchPermit
}
