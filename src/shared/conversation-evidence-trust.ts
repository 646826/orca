import { z } from 'zod'

export const ConversationEvidenceTrustScopeSchema = z.strictObject({
  operationKey: z.string().min(1),
  conversationId: z.string().min(1),
  contextGeneration: z.number().int().positive(),
  targetSessionId: z.string().min(1),
  candidateSegmentId: z.string().min(1),
  activationFence: z.number().int().positive(),
  nativeBindingGeneration: z.number().int().positive(),
  provider: z.string().min(1),
  accountBindingDigest: z.string().min(1),
  locationDigest: z.string().min(1),
  launchFingerprint: z.string().min(1),
  toolSchemaDigest: z.string().min(1),
  transport: z.enum(['claude-sdk-mcp', 'codex-dynamic-tool', 'acp-http-mcp'])
})
export type ConversationEvidenceTrustScope = z.infer<typeof ConversationEvidenceTrustScopeSchema>
export type ConversationEvidenceTrustChoice = {
  choiceDigest: string
  scope: ConversationEvidenceTrustScope
}

export const ConversationEvidenceTrustChoiceSchema = z
  .object({ choiceDigest: z.string().min(1), scope: ConversationEvidenceTrustScopeSchema })
  .strict()
