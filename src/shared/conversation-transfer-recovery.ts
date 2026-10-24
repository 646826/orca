import { z } from 'zod'
import { Identifier } from './rpc-contract/structured-agent-session-identifiers'
import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'

const Id = Identifier('Invalid transfer recovery identity', 512)
const Generation = z.number().int().positive().safe()
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
export const ConversationTransferRecoveryActionSchema = z.enum([
  'return-held-draft',
  'cancel-retain'
])
export const ConversationTransferRecoveryScopeSchema = z
  .object({
    operationKey: Id,
    transferId: Id,
    expectedVersion: Generation,
    expectedRevision: Generation,
    expectedContextGeneration: Generation,
    expectedActivationFence: Generation,
    expectedNativeBindingGeneration: Generation,
    expectedRuntimeFence: z.number().int().nonnegative().safe(),
    expectedTargetEpoch: Id,
    expectedRecoveryAttempt: z.number().int().nonnegative().safe(),
    expectedProofDigest: Digest
  })
  .strict()
export const ConversationTransferRecoveryParams = ConversationTransferRecoveryScopeSchema.extend({
  action: ConversationTransferRecoveryActionSchema,
  clientOperationId: Id.refine((value) => parseAgentSessionOperationTimestamp(value) !== null)
}).strict()
export const ConversationTransferRecoveryResultSchema = z
  .object({
    transferId: Id,
    operationKey: Id,
    action: ConversationTransferRecoveryActionSchema,
    sourceSessionId: Id,
    sourceMessageId: Id,
    conversationRevision: Generation,
    operationVersion: Generation
  })
  .strict()
export const ConversationTransferIntentionSchema = z
  .object({
    transferId: Id,
    kind: z.enum(['trigger', 'queued-continuation']),
    operationKey: Id,
    targetSessionId: Id,
    sourceSessionId: Id,
    sourceMessageId: Id,
    status: z.enum([
      'delivery-uncertain',
      'message-not-sent',
      'returned-held',
      'cancelled-retained',
      'accepted'
    ]),
    original: z
      .object({
        text: z.string().max(4096),
        truncated: z.boolean(),
        bodyBytes: z.number().int().nonnegative().safe(),
        bodyDigest: Digest,
        attachmentCount: z.number().int().nonnegative().safe()
      })
      .strict()
      .nullable(),
    actions: z.array(ConversationTransferRecoveryActionSchema).max(2),
    scope: ConversationTransferRecoveryScopeSchema.nullable()
  })
  .strict()
export const ConversationTransferIntentionCursorSchema = z
  .object({
    conversationId: Id,
    beforeOrdinal: Generation
  })
  .strict()
export const ConversationTransferIntentionsParams = z
  .object({
    conversationId: Id,
    before: ConversationTransferIntentionCursorSchema.nullable().default(null)
  })
  .strict()
export const ConversationTransferRecoveryViewSchema = z
  .object({
    version: z.literal(1),
    intentions: z.array(ConversationTransferIntentionSchema).max(8),
    next: ConversationTransferIntentionCursorSchema.nullable()
  })
  .strict()
export type ConversationTransferRecoveryRequest = z.infer<typeof ConversationTransferRecoveryParams>
export type ConversationTransferRecoveryResult = z.infer<
  typeof ConversationTransferRecoveryResultSchema
>
export type ConversationTransferRecoveryAction = z.infer<
  typeof ConversationTransferRecoveryActionSchema
>
export type ConversationTransferIntention = z.infer<typeof ConversationTransferIntentionSchema>
export type ConversationTransferRecoveryView = z.infer<
  typeof ConversationTransferRecoveryViewSchema
>

export type ConversationTransferRecoveryScope = z.infer<
  typeof ConversationTransferRecoveryScopeSchema
>
export type ConversationTransferIntentionCursor = z.infer<
  typeof ConversationTransferIntentionCursorSchema
>
