/** A live revision changed; durable corruption and missing evidence are separate failures. */
export class ConversationPreparationStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversationPreparationStaleError'
  }
}
