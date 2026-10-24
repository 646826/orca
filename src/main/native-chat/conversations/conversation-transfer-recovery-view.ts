import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import type Database from '../../sqlite/sync-database'
import type {
  ConversationTransferIntention,
  ConversationTransferRecoveryView,
  ConversationTransferIntentionCursor,
  ConversationTransferRecoveryScope
} from '../../../shared/conversation-transfer-recovery'
import { readPinnedQueuedMessageEvidence } from '../agent-session-journal/queued-message-origin'
import { conversationContextDigest } from './conversation-context-consent'
import { readConversation, readSwitchIntent, ConversationRefusal } from './conversation-read-model'
import {
  readHistoricalConversationTransferNoWrite,
  type ConversationTransferNoWriteProof
} from './conversation-transfer-no-write'
import {
  readRecoveryTransfer,
  requireTransferRecoveryAuthority
} from './conversation-transfer-recovery-authority'

function projectIntention(
  db: Database.Database,
  stateDirectory: string,
  transferId: string,
  currentRuntimeFence: (proof: ConversationTransferNoWriteProof) => number | null
): ConversationTransferIntention | null {
  let transfer: ReturnType<typeof readRecoveryTransfer>
  try {
    transfer = readRecoveryTransfer(db, transferId)
  } catch {
    return null
  }
  if (!transfer) {
    return null
  }
  const { binding } = transfer
  const receipt = db
    .prepare('SELECT action FROM conversation_transfer_recoveries WHERE transfer_id=?')
    .get(transferId)
  const proof = readHistoricalConversationTransferNoWrite(db, transferId)
  const conversation = readConversation(db, binding.conversationId)
  const intent = readSwitchIntent(db, binding.operationKey)
  let original: ConversationTransferIntention['original'] = null
  try {
    const evidence = readPinnedQueuedMessageEvidence(db, {
      ownerId: `conversation-transfer:${transferId}`,
      sourceSessionId: binding.queueSessionId,
      messageId: binding.messageId,
      fingerprint: binding.sourceFingerprint,
      maxBytes: 1024 * 1024
    })
    if (evidence) {
      let text = '',
        truncated = false,
        attachmentCount = 0
      for (const block of evidence.body.blocks) {
        if (block.type === 'text') {
          const separator = text.length ? '\n' : ''
          const remaining = 4096 - text.length
          const part = separator + block.text
          text += part.slice(0, remaining)
          truncated ||= part.length > remaining
        } else if (block.type === 'image-ref') {
          attachmentCount += 1
        }
      }
      original = {
        text,
        truncated,
        attachmentCount,
        bodyDigest: conversationContextDigest(evidence.body),
        bodyBytes: Buffer.byteLength(JSON.stringify(evidence.body))
      }
    }
  } catch {
    /* An unavailable original never erases the retained intention. */
  }
  const runtimeFence = proof ? currentRuntimeFence(proof) : null
  const currentEpoch = readJournalSessionEpoch(db, binding.targetSessionId)
  let scope: ConversationTransferRecoveryScope | null =
    proof && conversation && intent && runtimeFence !== null && currentEpoch !== null
      ? {
          operationKey: binding.operationKey,
          transferId,
          expectedVersion: intent.version,
          expectedRevision: conversation.revision,
          expectedContextGeneration: conversation.contextGeneration,
          expectedActivationFence: conversation.activationFence,
          expectedNativeBindingGeneration: intent.nativeBindingGeneration,
          expectedRuntimeFence: runtimeFence,
          expectedTargetEpoch: currentEpoch,
          expectedRecoveryAttempt: proof.recoveryAttempt,
          expectedProofDigest: conversationContextDigest(proof)
        }
      : null
  if (scope) {
    try {
      requireTransferRecoveryAuthority(db, scope, stateDirectory)
      if (!proof || currentRuntimeFence(proof) !== scope.expectedRuntimeFence) {
        scope = null
      }
    } catch {
      scope = null
    }
  }
  return {
    transferId,
    kind: binding.kind,
    operationKey: binding.operationKey,
    targetSessionId: binding.targetSessionId,
    sourceSessionId: binding.queueSessionId,
    sourceMessageId: binding.messageId,
    status:
      receipt?.action === 'return-held-draft'
        ? 'returned-held'
        : receipt?.action === 'cancel-retain'
          ? 'cancelled-retained'
          : transfer.state === 'accepted'
            ? 'accepted'
            : proof
              ? 'message-not-sent'
              : 'delivery-uncertain',
    original,
    actions: scope ? ['return-held-draft', 'cancel-retain'] : [],
    scope
  }
}

export function readConversationTransferIntentions(input: {
  db: Database.Database
  stateDirectory: string
  conversationId: string
  before?: ConversationTransferIntentionCursor | null
  currentRuntimeFence: (proof: ConversationTransferNoWriteProof) => number | null
}): ConversationTransferRecoveryView {
  if (input.before && input.before.conversationId !== input.conversationId) {
    throw new ConversationRefusal('scope-mismatch')
  }
  const rows = input.db
    .prepare(`SELECT r.rowid ordinal,r.transfer_id FROM conversation_trigger_reservations r
    JOIN conversation_switch_intents i ON i.operation_key=r.operation_key
    WHERE json_extract(r.binding_json,'$.conversationId')=? AND i.conversation_id=? AND r.state NOT IN ('reserved','converting','accepted')
      AND (r.state!='cancelled' OR EXISTS(SELECT 1 FROM conversation_transfer_recoveries x WHERE x.transfer_id=r.transfer_id))
      AND (? IS NULL OR r.rowid<?) ORDER BY r.rowid DESC LIMIT 9`)
    .all(
      input.conversationId,
      input.conversationId,
      input.before?.beforeOrdinal ?? null,
      input.before?.beforeOrdinal ?? null
    )
  const page = rows.slice(0, 8)
  const intentions = page.flatMap((row) => {
    const result =
      typeof row.transfer_id === 'string'
        ? projectIntention(
            input.db,
            input.stateDirectory,
            row.transfer_id,
            input.currentRuntimeFence
          )
        : null
    return result ? [result] : []
  })
  const last = page.at(-1)?.ordinal
  return {
    version: 1,
    intentions,
    next:
      rows.length > 8 && typeof last === 'number'
        ? { conversationId: input.conversationId, beforeOrdinal: last }
        : null
  }
}
