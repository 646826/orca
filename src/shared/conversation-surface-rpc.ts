import { ConversationTransferRecoveryViewSchema } from './conversation-transfer-recovery'
import { ConversationClearViewSchema } from './conversation-clear-record'
import { z } from 'zod'
import { isStructuredAgentId, type StructuredAgentId } from './agent-session-provider-handle'
import { isConversationRecord, type ConversationRecord } from './conversation-record'
import {
  isAgentSessionExecutionLocation,
  type AgentSessionExecutionLocation
} from './agent-session-record'
import { AGENT_CHAT_PERMISSION_MODES } from './agent-chat-permission-mode'
import { Identifier } from './rpc-contract/structured-agent-session-identifiers'
import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'

const Id = Identifier('Invalid conversation identity', 512)
const Positive = z.number().int().positive().safe()
const Label = z.string().min(1).max(256)
export const ConversationEnsureSourceSurfaceResultSchema = z
  .custom<ConversationRecord>(isConversationRecord)
  .and(z.object({ sourceTabId: Id }))
export const ConversationSelectAgentParams = z
  .object({
    conversationId: Id,
    expectedRevision: Positive,
    expectedContextGeneration: Positive,
    expectedActivationFence: Positive,
    agent: z.enum(['claude', 'codex', 'opencode']),
    nativeSession: z.enum(['retain-or-create', 'rebuild']),
    clientOperationId: Id.refine((value) => parseAgentSessionOperationTimestamp(value) !== null)
  })
  .strict()
export const ConversationSurfaceReadParams = z.object({ conversationId: Id }).strict()
export const ConversationPromoteSurfaceParams = ConversationSurfaceReadParams.extend({
  sourceSessionId: Id,
  expectedTabId: Id,
  expectedRevision: Positive
}).strict()
export const ConversationAgentDisplaySchema = z
  .object({
    sessionId: Id,
    agent: z.custom<StructuredAgentId>(isStructuredAgentId),
    agentLabel: Label,
    profile: z.discriminatedUnion('state', [
      z.object({ state: z.literal('configured'), label: Label }).strict(),
      z.object({ state: z.literal('unknown') }).strict()
    ]),
    authenticatedAccount: z.object({ state: z.literal('unknown') }).strict(),
    host: z.object({ id: Id, label: Label }).strict(),
    workspace: z
      .object({
        id: Id,
        label: Label,
        kind: z.enum(['folder', 'git-worktree']),
        wslDistro: Label.nullable()
      })
      .strict(),
    permissions: z
      .object({
        selected: z.enum(AGENT_CHAT_PERMISSION_MODES).nullable(),
        applied: z.enum(AGENT_CHAT_PERMISSION_MODES).nullable(),
        state: z.enum(['confirmed', 'unverified'])
      })
      .strict(),
    startupTrust: z.enum(['unobserved', 'approval-required', 'approved']),
    transport: z.enum(['unverified', 'first-user-turn', 'passive'])
  })
  .strict()
export const ConversationOperationViewSchema = z
  .object({
    operationKey: Id,
    conversationId: Id,
    targetSessionId: Id,
    candidateSegmentId: Id.nullable(),
    contextGeneration: Positive,
    activationFence: Positive,
    nativeBindingGeneration: Positive,
    version: Positive,
    phase: z.enum([
      'quiescing',
      'prepared',
      'delivering',
      'reconciliation-required',
      'activated',
      'cancelled'
    ]),
    sourceBoundaryCount: z.number().int().nonnegative().safe(),
    candidateBoundaryCount: z.number().int().nonnegative().safe()
  })
  .strict()
export const ConversationTabSurfaceSchema = z
  .object({
    conversationId: Id,
    sourceSessionId: Id,
    tabId: Id,
    location: z.custom<AgentSessionExecutionLocation>(isAgentSessionExecutionLocation),
    visible: z.boolean(),
    surfaceRevision: Positive,
    publishedRevision: z.number().int().nonnegative().safe()
  })
  .strict()
export const ConversationSurfaceSnapshotSchema = z
  .object({
    conversation: z.custom<ConversationRecord>(isConversationRecord),
    active: ConversationAgentDisplaySchema,
    selected: ConversationAgentDisplaySchema.nullable(),
    operation: ConversationOperationViewSchema.nullable(),
    clear: ConversationClearViewSchema.nullable().optional(),
    transferRecovery: ConversationTransferRecoveryViewSchema.optional(),
    archiveRevision: z.number().int().nonnegative().safe().optional(),
    surface: ConversationTabSurfaceSchema.nullable()
  })
  .strict()
export const ConversationSelectAgentResultSchema = z
  .object({
    decision: z.enum(['admitted', 'replayed', 'unchanged']),
    snapshot: ConversationSurfaceSnapshotSchema
  })
  .strict()
export const ConversationInvalidationSchema = z
  .object({
    conversationId: Id,
    revision: Positive,
    contextGeneration: Positive,
    activationFence: Positive,
    activeSegmentId: Id,
    pendingOperationKey: Id.nullable(),
    surfaceRevision: z.number().int().nonnegative().safe(),
    historyInvalidated: z.boolean()
  })
  .strict()
export type ConversationAgentDisplay = z.infer<typeof ConversationAgentDisplaySchema>
export type ConversationSurfaceSnapshot = z.infer<typeof ConversationSurfaceSnapshotSchema>
export type ConversationSelectAgentRequest = z.infer<typeof ConversationSelectAgentParams>
export type ConversationSelectAgentResult = z.infer<typeof ConversationSelectAgentResultSchema>
export type ConversationInvalidation = z.infer<typeof ConversationInvalidationSchema>

export const ConversationWatchEventSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('ready'), subscriptionId: Id, state: ConversationInvalidationSchema })
    .strict(),
  z.object({ type: z.literal('changed'), state: ConversationInvalidationSchema }).strict(),
  z.object({ type: z.literal('end') }).strict()
])
export const ConversationUnwatchParams = z.object({ subscriptionId: Id }).strict()
export type ConversationWatchEvent = z.infer<typeof ConversationWatchEventSchema>

export const ConversationSurfaceVisibilityParams = ConversationSurfaceReadParams.extend({
  expectedSurfaceRevision: Positive,
  visible: z.boolean()
}).strict()
