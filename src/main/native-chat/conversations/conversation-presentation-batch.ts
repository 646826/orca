import type Database from '../../sqlite/sync-database'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import {
  recordConversationSourceVersion,
  type ConversationCanonicalSourceVersionInput
} from './conversation-source-version'
import {
  CONVERSATION_SCRATCH_BATCH_ROWS,
  CONVERSATION_SCRATCH_BATCH_BYTES,
  type ConversationScratchReplayEntry
} from './conversation-scratch-protocol'

export function createConversationPresentationBatch(input: {
  db: Database.Database
  append: (entries: readonly ConversationScratchReplayEntry[]) => Promise<void>
  assertCurrent: () => void
}) {
  const pending: {
    entry: ConversationScratchReplayEntry
    proof: ConversationCanonicalSourceVersionInput
  }[] = []
  let bytes = 0
  const flush = async (): Promise<boolean> => {
    if (!pending.length) {
      return false
    }
    input.assertCurrent()
    await input.append(pending.map(({ entry }) => entry))
    input.assertCurrent()
    // Earlier committed proofs remain facts if this unpublished replay subsequently fails.
    runJournalTransaction(input.db, () => {
      for (const { proof } of pending) {
        recordConversationSourceVersion(input.db, proof)
      }
    })
    pending.length = 0
    bytes = 0
    return true
  }
  return {
    async add(
      entry: ConversationScratchReplayEntry,
      proof: ConversationCanonicalSourceVersionInput
    ): Promise<boolean> {
      const length = Buffer.byteLength(entry.rowJson)
      let committed = false
      if (pending.length && bytes + length > CONVERSATION_SCRATCH_BATCH_BYTES) {
        committed = await flush()
      }
      pending.push({ entry, proof })
      bytes += length
      if (
        pending.length >= CONVERSATION_SCRATCH_BATCH_ROWS ||
        bytes >= CONVERSATION_SCRATCH_BATCH_BYTES
      ) {
        committed = await flush()
      }
      return committed
    },
    flush
  }
}
