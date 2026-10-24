import type Database from '../../sqlite/sync-database'
import type {
  ConversationContextManifest,
  ConversationEvidenceGap
} from '../../../shared/conversation-handoff'
import type { ConversationPreparationEvidencePage } from '../../../shared/conversation-rpc'
import { ConversationRpcRefusal } from '../../../shared/conversation-rpc-refusal'
import { readConversationManifestParts } from './conversation-context-parts'
/** Caller verifies the exact live preparation before and after reading these immutable parts. */
export function readConversationPreparationEvidencePage(
  db: Database.Database,
  manifest: ConversationContextManifest,
  after: number,
  limit: number
): ConversationPreparationEvidencePage {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 128
  ) {
    throw new ConversationRpcRefusal('resource-limit')
  }
  const indexed = manifest.evidenceIndex
  const parts = indexed
    ? readConversationManifestParts(db, indexed.indexId, after, limit)
    : manifest.projection.slice(after, after + limit).map((part, i) => ({
        ordinal: after + i + 1,
        part,
        gaps: manifest.gaps.filter((gap) => sameSource(gap, part.version.source))
      }))
  const result: ConversationPreparationEvidencePage = {
    manifestDigest: manifest.digest,
    sourceRevision: manifest.sourceRevision,
    targetBindingDigest: manifest.targetBindingDigest,
    transformationsDigest: manifest.transformationsDigest,
    omissionsDigest: manifest.omissionsDigest,
    manifestGaps: manifest.gaps,
    entries: [],
    next: after,
    complete: false
  }
  for (const { ordinal, part, gaps } of parts) {
    const entry = {
      ordinal,
      version: part.version,
      representation: part.representation,
      spans: part.spans,
      gaps,
      ...(part.representation !== 'exact' && part.text !== undefined
        ? { transformedText: part.text }
        : {})
    }
    const candidate = { ...result, entries: [...result.entries, entry], next: ordinal }
    if (Buffer.byteLength(JSON.stringify(candidate)) > 512 * 1024) {
      if (!result.entries.length) {
        throw new ConversationRpcRefusal('resource-limit')
      }
      return result
    }
    result.entries.push(entry)
    result.next = ordinal
  }
  const count = indexed?.partCount ?? manifest.projection.length
  if ((result.next ?? after) >= count) {
    result.complete = true
    result.next = null
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) {
    throw new ConversationRpcRefusal('resource-limit')
  }
  return result
}
function sameSource(
  gap: ConversationEvidenceGap,
  source: ConversationEvidenceGap['source']
): boolean {
  return (
    gap.source.sessionId === source.sessionId &&
    gap.source.epoch === source.epoch &&
    gap.source.sequence === source.sequence
  )
}
