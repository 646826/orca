import { z } from 'zod'
import { Identifier } from './rpc-contract/structured-agent-session-identifiers'
import { parseAgentSessionOperationTimestamp } from './agent-session-host-authority'
const Id = Identifier('Invalid conversation archive identity', 512)
export const ConversationArchiveDeleteParams = z
  .object({
    conversationId: Id,
    expectedRevision: z.number().int().positive().safe(),
    contextGeneration: z.number().int().positive().safe(),
    clientOperationId: Id.refine((value) => parseAgentSessionOperationTimestamp(value) !== null)
  })
  .strict()
export const ConversationArchiveCleanupParams = z
  .object({
    conversationId: Id,
    operationKey: Id
  })
  .strict()

export const ConversationArchiveStatusParams = z
  .object({ conversationId: Id, contextGeneration: z.number().int().positive().safe() })
  .strict()
