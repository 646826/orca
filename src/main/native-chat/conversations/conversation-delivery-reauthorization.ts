import type Database from '../../sqlite/sync-database'
import { readConversationManifest } from './conversation-context-coverage'
import { authorizeConversationManifestIndex } from './conversation-context-index-authority'
import {
  verifyConversationContextEvidence,
  type ConversationContextEvidenceReader
} from './conversation-context-authority'

/** Revalidates bounded source pages after host claims/origins change; never run under a session queue. */
export async function refreshVerifiedConversationManifestIndex(
  db: Database.Database,
  manifestId: string,
  readEvidence: ConversationContextEvidenceReader,
  signal: AbortSignal
): Promise<void> {
  if (db.isTransaction) {
    throw new Error('Delivery reauthorization cannot run under a writer transaction')
  }
  signal.throwIfAborted()
  const manifest = readConversationManifest(db, manifestId)
  if (!manifest) {
    throw new Error('Delivery manifest is unavailable')
  }
  verifyConversationContextEvidence(db, manifest, readEvidence)
  if (manifest.evidenceIndex) {
    await authorizeConversationManifestIndex(db, manifest, readEvidence, signal)
  }
  signal.throwIfAborted()
}
