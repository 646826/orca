import { z } from 'zod'
const text = z.string().min(1)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
export const conversationDeliveryPlanSchema = z
  .object({
    planId: text,
    operationKey: text,
    intentVersion: z.number().int().positive(),
    manifestId: text,
    manifestDigest: digest,
    assignmentDigest: digest,
    inlineDeltaKeys: z.array(digest).max(4096),
    targetSessionId: text,
    contextGeneration: z.number().int().positive(),
    nativeBindingGeneration: z.number().int().positive(),
    nativeIdentityDigest: digest,
    runtimeFence: z.number().int().nonnegative(),
    nativeSessionId: text,
    transport: z.enum(['codex', 'claude', 'acp']),
    envelopeDigest: digest,
    partCount: z.number().int().nonnegative(),
    acceptedPriorCount: z.number().int().nonnegative(),
    retrievalCount: z.number().int().nonnegative()
  })
  .strict()
export type ConversationDeliveryPlan = z.infer<typeof conversationDeliveryPlanSchema>
export function createConversationDeliveryTablesSql(): string {
  return `CREATE TABLE IF NOT EXISTS conversation_delivery_plans (
    plan_id TEXT PRIMARY KEY,operation_key TEXT NOT NULL REFERENCES conversation_switch_intents(operation_key),
    manifest_id TEXT NOT NULL REFERENCES conversation_context_manifests(manifest_id),plan_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversation_delivery_inputs (
    plan_id TEXT PRIMARY KEY REFERENCES conversation_delivery_plans(plan_id),submission_id TEXT NOT NULL,
    payload_fingerprint TEXT NOT NULL,payload_digest TEXT NOT NULL,attachments_digest TEXT NOT NULL,
    epoch TEXT NOT NULL,sequence INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS conversation_delivery_receipts (
    receipt_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES conversation_delivery_plans(plan_id),
    authority_revision INTEGER NOT NULL,coverage_revision INTEGER NOT NULL,evidence_json TEXT NOT NULL);
  ${[
    'conversation_delivery_plans',
    'conversation_delivery_inputs',
    'conversation_delivery_receipts'
  ]
    .map(
      (table) => `
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'delivery evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_replace BEFORE INSERT ON ${table}
    WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${table === 'conversation_delivery_receipts' ? 'receipt_id=NEW.receipt_id' : 'plan_id=NEW.plan_id'})
    BEGIN SELECT RAISE(ABORT,'delivery evidence cannot be replaced'); END;`
    )
    .join('\n')}`
}
