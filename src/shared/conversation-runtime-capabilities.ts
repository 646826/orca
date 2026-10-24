export const NATIVE_CONVERSATION_TRANSFER_RECOVERY_CAPABILITY =
  'agent-session.conversations.transfer-recovery.v1' as const

/** v2 requires source-surface identity, nullable estimates and authenticated transport projections. */
export const NATIVE_CONVERSATION_RUNTIME_CAPABILITY = 'agent-session.conversations.v2' as const

/** Read-only aggregate history/inventory; never admits mutation or native control. */
export const NATIVE_CONVERSATION_READ_CAPABILITY = 'agent-session.conversations.read.v1' as const

export function supportsConversationRead(capabilities: readonly string[] | undefined): boolean {
  return (
    capabilities?.some(
      (capability) =>
        capability === NATIVE_CONVERSATION_RUNTIME_CAPABILITY ||
        capability === NATIVE_CONVERSATION_READ_CAPABILITY
    ) === true
  )
}
