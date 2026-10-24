import { MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS } from './agent-session-provider-handle'
import { z } from 'zod'

/** Logical context clear preserves visible archive; it is never provider-side erasure. */
export const ConversationClearIntentSchema = z
  .object({
    operationKey: z.string().min(1),
    conversationId: z.string().min(1),
    version: z.number().int().positive(),
    contextGeneration: z.number().int().positive(),
    activationFence: z.number().int().nonnegative(),
    phase: z.enum(['quiescing', 'prepared', 'committed', 'reconciliation-required', 'cancelled']),
    preserveArchive: z.literal(true),
    sourceBoundaries: z
      .array(
        z.object({
          sessionId: z.string().min(1),
          epoch: z.string().min(1),
          endSequence: z.number().int().positive()
        })
      )
      .min(1),
    participants: z
      .array(
        z.object({
          sessionId: z.string().min(1),
          nativeBindingGeneration: z.number().int().positive(),
          runtimeFence: z.number().int().nonnegative(),
          recordBirthDigest: z.string().regex(/^[a-f0-9]{64}$/),
          nativeIdentities: z
            .array(z.string().regex(/^[a-f0-9]{64}$/))
            .max(MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS)
            .optional()
        })
      )
      .min(1)
  })
  .superRefine((intent, ctx) => {
    if (new Set(intent.participants.map((p) => p.sessionId)).size !== intent.participants.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate clear participant' })
    }
  })
export type ConversationClearIntent = z.infer<typeof ConversationClearIntentSchema>

export const ConversationClearViewSchema = z.object({
  operationKey: ConversationClearIntentSchema.shape.operationKey,
  conversationId: ConversationClearIntentSchema.shape.conversationId,
  version: ConversationClearIntentSchema.shape.version,
  contextGeneration: ConversationClearIntentSchema.shape.contextGeneration,
  activationFence: ConversationClearIntentSchema.shape.activationFence,
  phase: ConversationClearIntentSchema.shape.phase,
  preserveArchive: ConversationClearIntentSchema.shape.preserveArchive
})
export type ConversationClearView = z.infer<typeof ConversationClearViewSchema>
