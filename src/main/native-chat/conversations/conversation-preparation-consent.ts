import { z } from 'zod'
import type Database from '../../sqlite/sync-database'
import type { ConversationProjectionConsent } from '../../../shared/conversation-handoff'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { readSwitchIntent, readConversation } from './conversation-read-model'
import {
  consentForConversationManifest,
  conversationContextDigest
} from './conversation-context-consent'
import type { createConversationPreparationAuthority } from './conversation-preparation-authority'

const consentSchema = z.object({
  manifestDigest: z.string().min(1),
  targetBindingDigest: z.string().min(1),
  capabilityFingerprint: z.string().min(1),
  transformationsDigest: z.string().min(1),
  omissionsDigest: z.string().min(1),
  approvedBy: z.string().min(1)
})
export type ConversationPreparationConsentRequest = Omit<
  ConversationProjectionConsent,
  'approvedBy'
> & {
  operationKey: string
  expectedVersion: number
  expectedContextGeneration: number
}
export function readConversationPreparationConsent(
  db: Database.Database,
  manifestId: string
): ConversationProjectionConsent | null {
  const row = db
    .prepare('SELECT consent_json FROM conversation_preparation_consents WHERE manifest_id=?')
    .get(manifestId)
  return row ? consentSchema.parse(JSON.parse(String(row.consent_json))) : null
}

/** Caller identity and workspace authorization come from the host RPC context, never request JSON. */
export function approveConversationPreparation(
  db: Database.Database,
  request: ConversationPreparationConsentRequest,
  authorizedCallerKey: string,
  authority: ReturnType<typeof createConversationPreparationAuthority>
): void {
  if (!authorizedCallerKey) {
    throw new Error('Consent caller unavailable')
  }
  runJournalTransaction(db, () => {
    const preview = authority.readPreview(request.manifestDigest)
    const intent = readSwitchIntent(db, request.operationKey)
    if (
      !preview ||
      !intent ||
      preview.sources.operationKey !== intent.operationKey ||
      intent.version !== request.expectedVersion ||
      intent.contextGeneration !== request.expectedContextGeneration ||
      (intent.phase !== 'quiescing' && intent.phase !== 'prepared') ||
      readConversation(db, intent.conversationId)?.pendingOperationKey !== intent.operationKey ||
      !authority.readPreparationEvidence(db, preview.manifest)
    ) {
      throw new Error('Consent preview changed')
    }
    const expected = consentForConversationManifest(preview.manifest, authorizedCallerKey)
    const actual = consentSchema.parse({ ...request, approvedBy: authorizedCallerKey })
    if (conversationContextDigest(expected) !== conversationContextDigest(actual)) {
      throw new Error('Consent does not match preview')
    }
    const existing = readConversationPreparationConsent(db, preview.manifest.manifestId)
    if (existing) {
      if (conversationContextDigest(existing) !== conversationContextDigest(expected)) {
        throw new Error('Consent already recorded by another caller')
      }
      return
    }
    db.prepare('INSERT INTO conversation_preparation_consents VALUES(?,?)').run(
      preview.manifest.manifestId,
      JSON.stringify(expected)
    )
  })
}
