import type { ConversationAttachmentVersion } from '../agent-session-attachments/conversation-attachment-claims'
import { ConversationExportError } from './conversation-export-error'

export type ConversationArtifactDisclosure = {
  targetBindingDigest: string
  /** Trusted host policy, not client-selected include/exclude or a universal secret detector. */
  resolve: (version: ConversationAttachmentVersion) => {
    version: ConversationAttachmentVersion
    conversationId: string
    contextGeneration: number
    targetBindingDigest: string
    action: 'include' | 'exclude'
  } | null
}
export function assertConversationArtifactDisclosure(
  input: {
    conversationId: string
    contextGeneration: number
    disclosure?: ConversationArtifactDisclosure
  },
  version: ConversationAttachmentVersion,
  frozenTarget: string | undefined
): void {
  const authority = input.disclosure
  const fact = authority?.resolve(version)
  if (
    !authority ||
    !fact ||
    !frozenTarget ||
    !/^[a-f0-9]{64}$/.test(frozenTarget) ||
    authority.targetBindingDigest !== frozenTarget ||
    fact.targetBindingDigest !== frozenTarget ||
    fact.conversationId !== input.conversationId ||
    fact.contextGeneration !== input.contextGeneration ||
    fact.version.uploadId !== version.uploadId ||
    fact.version.name !== version.name ||
    fact.version.sha256 !== version.sha256 ||
    fact.version.byteLength !== version.byteLength
  ) {
    throw new ConversationExportError('scope')
  }
  if (fact.action !== 'include') {
    throw new ConversationExportError('excluded')
  }
}
