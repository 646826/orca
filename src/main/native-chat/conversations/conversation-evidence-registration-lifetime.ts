import type { ConversationEvidenceNativeOwner } from './conversation-evidence-registration'
import type { ConversationEvidenceTrustChoice } from './conversation-evidence-trust'
import type { openConversationEvidenceReader } from './conversation-evidence-reader'
import { ConversationExportError } from './conversation-export-error'
type Reader = ReturnType<typeof openConversationEvidenceReader>
export type ConversationEvidenceRegistrationEntry = {
  id: string
  choice: ConversationEvidenceTrustChoice
  owner: ConversationEvidenceNativeOwner | null
  controller: AbortController
  revoked: boolean
  reader: Reader | null
  planId: string | null
  bindingRevision: number
  cleanup: Promise<void> | null
  promoted: boolean
  assertPending(): void
  detach(): void
}
export function retireConversationEvidenceRegistration(
  entries: Map<string, ConversationEvidenceRegistrationEntry>,
  sessionId: string,
  entry: ConversationEvidenceRegistrationEntry
): Promise<void> {
  if (entry.cleanup) {
    return entry.cleanup
  }
  entry.detach()
  entry.revoked = true
  entry.bindingRevision++
  entry.controller.abort(new ConversationExportError('scope'))
  const cleanup = Promise.resolve()
    .then(() => entry.reader?.close())
    .then(() => {
      if (entries.get(sessionId) === entry) {
        entries.delete(sessionId)
      }
    })
  entry.cleanup = cleanup
  // Keep failed cleanup observable to explicit close without an unhandled background rejection.
  void cleanup.catch(() => undefined)
  return cleanup
}
