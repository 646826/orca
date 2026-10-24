import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import type {
  ConversationContextManifest,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import { conversationContextDigest } from './conversation-context-consent'

/** Canonical payload classification only, never semantic inference about which instruction wins. */
export function canonicalUserTextBlocks(raw: string | undefined): string[] {
  if (raw === undefined) {
    return []
  }
  const parsed = parseJournalRow(raw)
  if (!parsed.ok) {
    return []
  }
  const row = parsed.row
  if (row.kind === 'submission' && row.origin === 'host') {
    return []
  }
  const bodies =
    row.kind === 'item' || row.kind === 'submission'
      ? [row.body]
      : row.kind === 'lifecycle-batch'
        ? row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
        : []
  return bodies.flatMap((body) =>
    body.kind === 'message' && body.role === 'user'
      ? body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}
export function canonicalUserConstraint(raw: string | undefined, constraint: string): boolean {
  return canonicalUserTextBlocks(raw).some((text) => text.includes(constraint))
}

/** Unknown/opaque bytes need host capture metadata; visible user bytes cannot be demoted by a label. */
export function canonicalSourceRequiresInline(raw: string | undefined): boolean {
  const parsed = raw === undefined ? null : parseJournalRow(raw)
  // Host submissions include queued user drafts; retaining them does not grant user authority.
  return (
    (parsed?.ok && parsed.row.kind === 'submission' && parsed.row.body.role === 'user') ||
    canonicalUserTextBlocks(raw).some((text) => text.length > 0)
  )
}

export function conversationRepresentationRequiresInline(
  manifest: Pick<ConversationContextManifest, 'mandatory'>,
  part: ConversationContextRepresentation
): boolean {
  return (
    part.representation === 'transport-projected' ||
    canonicalSourceRequiresInline(part.text) ||
    manifest.mandatory.some((constraint) =>
      constraint.sources.some(
        (version) => conversationContextDigest(version) === conversationContextDigest(part.version)
      )
    )
  )
}
