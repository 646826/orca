import { z } from 'zod'
import { ConversationTabSurfaceSchema } from './conversation-surface-rpc'

/** Metadata admission bound, never a truncated authoritative census. */
export const MAX_CONVERSATION_INVENTORY_BYTES = 512 * 1024
export type ConversationInventorySurface = z.infer<typeof ConversationTabSurfaceSchema>
export const ConversationSurfaceInventorySchema = z.discriminatedUnion('complete', [
  z.object({ complete: z.literal(true), surfaces: z.array(ConversationTabSurfaceSchema) }),
  z.object({ complete: z.literal(false), reason: z.enum(['unavailable', 'resource-limit']) })
])
export type ConversationSurfaceInventory = z.infer<typeof ConversationSurfaceInventorySchema>

/** A stable aggregate identity; the committed participant is display metadata, not send authority. */
export const RuntimeMobileSessionConversationTabSchema = z.object({
  type: z.literal('conversation'),
  id: z.string().min(1),
  conversationId: z.string().min(1),
  title: z.string(),
  activeSessionId: z.string().min(1),
  activeAgent: z.enum(['claude', 'codex', 'opencode']),
  contextGeneration: z.number().int().positive(),
  activationFence: z.number().int().nonnegative(),
  surfaceRevision: z.number().int().nonnegative(),
  color: z.string().nullable().optional(),
  isPinned: z.boolean().optional(),
  isActive: z.boolean()
})
export type RuntimeMobileSessionConversationTab = z.infer<
  typeof RuntimeMobileSessionConversationTabSchema
>
