import type Database from '../../sqlite/sync-database'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import { MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS } from '../agent-session-journal/journal-row-schema'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import {
  assertConversationOrigin,
  parseConversationOrigin,
  ConversationOriginUnresolvedError
} from './conversation-origin'
import { ConversationRefusal } from './conversation-read-model'
import { prepareConversationSourceAtomReceipt } from './conversation-source-atoms'

/** Derive bounded canonical proofs only from complete captured origins, never an enrollment span. */
export function prepareConversationOriginSourceAtomReceipt(
  db: Database.Database,
  input: {
    pin: JournalEpochPin
    source: ConversationSourceRef
    conversationId: string
    contextGeneration: number
    mutationCount: number
  }
): JournalOperationReceipt | null {
  if (
    db.isTransaction ||
    !Number.isSafeInteger(input.mutationCount) ||
    input.mutationCount < 0 ||
    input.mutationCount > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
  ) {
    throw new ConversationRefusal('corrupt-record')
  }
  const source = { ...input.source }
  const read = () =>
    db
      .prepare(
        'SELECT atom_path,origin_json FROM conversation_origin_rows WHERE session_id=? AND epoch=? AND sequence=? ORDER BY atom_path LIMIT ?'
      )
      .all(source.sessionId, source.epoch, source.sequence, input.mutationCount + 2)
  const captured = read()
  if (!captured.length) {
    return null
  }
  const paths = new Map(captured.map((row) => [row.atom_path, row.origin_json]))
  if (captured.length !== input.mutationCount + 1 || paths.size !== captured.length) {
    throw new ConversationOriginUnresolvedError()
  }
  const origin = (path: string) => {
    const json = paths.get(path)
    if (typeof json !== 'string') {
      throw new ConversationOriginUnresolvedError()
    }
    const value = parseConversationOrigin(JSON.parse(json))
    assertConversationOrigin(db, source.sessionId, value)
    if (
      value.conversationId !== input.conversationId ||
      value.contextGeneration !== input.contextGeneration
    ) {
      throw new ConversationRefusal('scope-mismatch')
    }
    return { ...value, sessionId: source.sessionId }
  }
  const receipt = prepareConversationSourceAtomReceipt(db, {
    pin: input.pin,
    source,
    envelopeOrigin: origin('$'),
    mutationOrigins: Array.from({ length: input.mutationCount }, (_, batchIndex) => ({
      batchIndex,
      origin: origin(`$.mutations[${batchIndex}]`)
    }))
  })
  const capturedJson = JSON.stringify(captured)
  return {
    write: (connection) => {
      if (connection !== db || !connection.isTransaction) {
        throw new ConversationRefusal('scope-mismatch')
      }
      if (JSON.stringify(read()) !== capturedJson) {
        throw new ConversationOriginUnresolvedError()
      }
      receipt.write(connection)
    },
    committed: receipt.committed
  }
}
