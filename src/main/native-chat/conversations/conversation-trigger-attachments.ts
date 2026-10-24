import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot,
  parseAgentSessionAttachmentStorePath
} from '../agent-session-attachments/agent-session-attachment-references'
import {
  verifyConversationAttachment,
  type ConversationAttachmentVersion
} from '../agent-session-attachments/conversation-attachment-claims'
import { conversationContextDigest } from './conversation-context-consent'
import type { ConversationTriggerBinding } from './conversation-trigger-schema'

export function conversationTriggerClaimOwner(transferId: string): string {
  return `conversation-transfer:${transferId}`
}
export function readConversationTriggerAttachments(
  db: Database.Database,
  transferId: string
): ConversationAttachmentVersion[] {
  return db
    .prepare(
      'SELECT upload_id,name,sha256,byte_length FROM conversation_attachment_claims WHERE owner_id=? ORDER BY upload_id,name'
    )
    .all(conversationTriggerClaimOwner(transferId))
    .map((row) => {
      if (
        typeof row.upload_id !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.sha256 !== 'string' ||
        typeof row.byte_length !== 'number'
      ) {
        throw new Error('Invalid trigger attachment claim')
      }
      return {
        uploadId: row.upload_id,
        name: row.name,
        sha256: row.sha256,
        byteLength: row.byte_length
      }
    })
}

/** Only managed committed uploads are retained. Workspace paths and remote image URLs need intake. */
export async function captureConversationTriggerAttachments(
  stateDirectory: string,
  body: AgentJournalMessageItem,
  signal: AbortSignal
): Promise<ConversationAttachmentVersion[]> {
  const root = agentSessionAttachmentStoreRoot(stateDirectory)
  for (const block of body.blocks) {
    if (
      block.type === 'image-ref' &&
      (!block.path || !parseAgentSessionAttachmentStorePath(root, block.path))
    ) {
      throw new Error('Trigger image requires managed attachment intake')
    }
  }
  const result: ConversationAttachmentVersion[] = []
  const ids = [...agentSessionAttachmentReferences(root, body)].sort()
  for (const uploadId of ids) {
    signal.throwIfAborted()
    const entries = await readdir(join(root, uploadId))
    if (entries.length !== 1) {
      throw new Error('Trigger upload is incomplete or ambiguous')
    }
    result.push(
      await verifyConversationAttachment({
        stateDirectory,
        path: join(root, uploadId, entries[0]!),
        signal
      })
    )
  }
  return result.sort((a, b) => a.uploadId.localeCompare(b.uploadId) || a.name.localeCompare(b.name))
}

/** Outside SQLite/session queues, immediately before delivery; SQL claims alone do not prove bytes. */
export async function verifyConversationTriggerAttachmentBytes(
  stateDirectory: string,
  db: Database.Database,
  binding: ConversationTriggerBinding,
  signal: AbortSignal
): Promise<void> {
  if (db.isTransaction) {
    throw new Error('Attachment verification cannot wait in a transaction')
  }
  const claims = readConversationTriggerAttachments(db, binding.transferId)
  if (conversationContextDigest(claims) !== binding.attachmentClaimsDigest) {
    throw new Error('Trigger attachment claims changed')
  }
  for (const expected of claims) {
    await verifyConversationAttachment({
      stateDirectory,
      path: join(agentSessionAttachmentStoreRoot(stateDirectory), expected.uploadId, expected.name),
      expected,
      signal
    })
  }
}
