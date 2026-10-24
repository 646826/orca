import { createHash } from 'node:crypto'
import { conversationContextDigest } from './conversation-context-consent'

export type ConversationNativeTransport = 'codex' | 'claude' | 'acp'
export type ConversationNativeInputObservation = {
  transport: ConversationNativeTransport
  payload: unknown
}
export type ConversationBeforeContextDispatch = (
  observation: ConversationNativeInputObservation
) => Promise<void>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid native context payload')
  }
  return Object.fromEntries(Object.entries(value))
}

/** Run on the final adapter request immediately before writing; never persist payload contents. */
export function verifyConversationNativeInput(
  input: ConversationNativeInputObservation & {
    expectedModel?: string
    expectedText: string
    nativeSessionId: string
    expectedAttachments: readonly unknown[]
    expectedAdditionalText?: readonly string[]
  }
): { textDigest: string; payloadDigest: string; attachmentsDigest: string } {
  const payload = record(input.payload)
  let blocks: unknown
  let sessionId: unknown
  if (input.transport === 'codex') {
    if (
      input.expectedModel !== undefined &&
      typeof payload.model === 'string' &&
      payload.model !== input.expectedModel
    ) {
      throw new Error('Native model differs from prepared context')
    }
    sessionId = payload.threadId
    blocks = payload.input
  } else if (input.transport === 'claude') {
    const message = record(payload.message)
    if (payload.type !== 'user' || message.role !== 'user') {
      throw new Error('Context is not a native user input')
    }
    sessionId = payload.session_id
    blocks = message.content
  } else {
    sessionId = payload.sessionId
    blocks = payload.prompt
  }
  if (sessionId !== input.nativeSessionId || !Array.isArray(blocks) || !input.expectedText) {
    throw new Error('Native context identity or content mismatch')
  }
  const entries = blocks.map(record)
  const actualText = entries.filter((block) => block.type === 'text').map((block) => block.text)
  if (input.transport === 'claude') {
    // Claude consumes only the trailing text block; its serializer joins nonempty source blocks.
    const expectedPrompt = [input.expectedText, ...(input.expectedAdditionalText ?? [])]
      .filter((text) => text.length > 0)
      .join('\n')
    if (actualText.length !== 1 || actualText[0] !== expectedPrompt) {
      throw new Error('Native Claude prompt differs from prepared ordered text')
    }
  } else {
    const exact = entries.filter(
      (block) => block.type === 'text' && block.text === input.expectedText
    )
    if (exact.length !== 1) {
      throw new Error('Native context envelope is missing or duplicated')
    }
    const additional = actualText.filter((text) => text !== input.expectedText)
    if (
      conversationContextDigest(additional) !==
      conversationContextDigest(input.expectedAdditionalText ?? [])
    ) {
      throw new Error('Native input contains unapproved additional text')
    }
  }
  const attachments = entries.filter((block) => block.type !== 'text')
  const attachmentsDigest = conversationContextDigest(attachments)
  if (attachmentsDigest !== conversationContextDigest(input.expectedAttachments)) {
    throw new Error('Native context attachment mapping changed')
  }
  return {
    textDigest: createHash('sha256').update(input.expectedText).digest('hex'),
    payloadDigest: createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),
    attachmentsDigest
  }
}
