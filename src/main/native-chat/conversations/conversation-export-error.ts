export class ConversationExportError extends Error {
  constructor(
    readonly code:
      | 'scope'
      | 'excluded'
      | 'resource-limit'
      | 'missing-source'
      | 'corrupt-source'
      | 'newer-schema'
  ) {
    super(`Conversation export ${code}`)
  }
}
