import { z } from 'zod'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { parseAgentSessionOperationTimestamp } from '../agent-session-host-authority'

const ConversationId = Identifier('Invalid conversation id')
const Generation = z.number().int().positive().safe()
export const ConversationEnsureParams = z
  .object({ sessionId: SessionId, includeSourceSurface: z.literal(true).optional() })
  .strict()
export const ConversationReadParams = z
  .object({
    conversationId: ConversationId,
    segmentPage: z
      .object({
        beforeOrdinal: Generation.nullable().default(null),
        limit: z.number().int().min(1).max(128).default(16)
      })
      .strict()
      .optional(),
    after: z
      .object({
        segmentOrdinal: Generation,
        epochOrdinal: Generation,
        sequence: Generation
      })
      .strict()
      .nullable()
      .optional(),
    limit: z.number().int().min(1).max(256).default(128)
  })
  .strict()

/** Native identity, account and location are resolved from host records. */
export const ConversationSwitchParams = z
  .object({
    conversationId: ConversationId,
    targetSessionId: SessionId,
    clientOperationId: Identifier('Invalid client operation id').refine(
      (value) => parseAgentSessionOperationTimestamp(value) !== null,
      'Invalid agent operation ID'
    ),
    expectedRevision: Generation,
    expectedContextGeneration: Generation,
    expectedActivationFence: Generation,
    expectedNativeBindingGeneration: Generation
  })
  .strict()

const OperationKey = Identifier('Invalid conversation operation key', 512)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
export const ConversationOperationParams = z.object({ operationKey: OperationKey }).strict()
export const ConversationAdvanceParams = ConversationOperationParams.extend({
  expectedVersion: Generation
}).strict()
export const ConversationRecipientParams = ConversationAdvanceParams.extend({
  expectedContextGeneration: Generation,
  expectedApprovalRevision: z.number().int().nonnegative().safe(),
  targetBindingDigest: Digest,
  capabilityFingerprint: Identifier('Invalid capability fingerprint', 512),
  policy: z.enum(['full', 'budgeted', 'fresh']),
  disclosure: z.literal('available-canonical')
}).strict()
export const ConversationManifestParams = ConversationAdvanceParams.extend({
  expectedContextGeneration: Generation,
  manifestDigest: Digest,
  targetBindingDigest: Digest,
  capabilityFingerprint: Identifier('Invalid capability fingerprint', 512),
  transformationsDigest: Digest,
  omissionsDigest: Digest
}).strict()
export const ConversationCancelParams = ConversationAdvanceParams.extend({
  expectedRevision: Generation,
  expectedContextGeneration: Generation,
  expectedActivationFence: Generation
}).strict()
export const ConversationHistoryParams = z
  .object({
    conversationId: ConversationId,
    segmentId: Identifier('Invalid segment id'),
    expectedSourceRevision: Digest,
    direction: z.enum(['forward', 'backward']).optional(),
    after: z
      .object({
        epochOrdinal: Generation,
        sequence: z.number().int().nonnegative().safe(),
        index: z.number().int().nonnegative().safe(),
        ordinal: Generation
      })
      .strict()
      .nullable()
      .default(null),
    limit: z.number().int().min(1).max(128).default(64)
  })
  .strict()

export const ConversationTrustParams = ConversationOperationParams.extend({
  choiceDigest: Digest
}).strict()

export const ConversationPreparationEvidenceParams = ConversationOperationParams.extend({
  manifestDigest: Digest,
  after: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().min(1).max(128).default(64)
}).strict()

export const ConversationClearParams = ConversationSwitchParams.omit({
  targetSessionId: true,
  expectedNativeBindingGeneration: true
}).strict()
