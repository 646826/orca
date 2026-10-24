import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type Database from '../../sqlite/sync-database'
import type { ConversationSourceRef } from '../../../shared/conversation-record'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import { ConversationRefusal } from './conversation-read-model'
export type ConversationCanonicalSourceVersionInput = {
  pin: JournalEpochPin
  source: ConversationSourceRef
  sha256: string
  byteLength: number
  kind: JournalRow['kind']
  mutationCount: number
}
export function assertConversationSourceVersionPin(
  db: Database.Database,
  { pin, source }: Pick<ConversationCanonicalSourceVersionInput, 'pin' | 'source'>
): void {
  if (
    source.sessionId !== pin.sessionId ||
    source.epoch !== pin.epoch ||
    source.sequence < 1 ||
    source.sequence > pin.endSequence ||
    source.batchIndex !== undefined ||
    source.itemId !== undefined ||
    source.itemRevision !== undefined
  ) {
    throw new ConversationRefusal('missing-source')
  }
  const held = db
    .prepare(
      'SELECT end_sequence FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?'
    )
    .get(pin.ownerId, pin.sessionId, pin.epoch)
  if (
    held?.end_sequence !== pin.endSequence ||
    !db
      .prepare('SELECT 1 FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(source.sessionId, source.epoch, source.sequence)
  ) {
    throw new ConversationRefusal('missing-source')
  }
}
/** Trusted frozen exporter/writer evidence only; never accept a client-supplied digest as proof. */
export function recordConversationSourceVersion(
  db: Database.Database,
  input: ConversationCanonicalSourceVersionInput
): void {
  if (
    !db.isTransaction ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    !Number.isSafeInteger(input.mutationCount) ||
    input.mutationCount < 0 ||
    (input.kind !== 'lifecycle-batch' && input.mutationCount !== 0)
  ) {
    throw new ConversationRefusal('corrupt-record')
  }
  assertConversationSourceVersionPin(db, input)
  const { source } = input
  const prior = db
    .prepare(
      'SELECT sha256,byte_length,row_kind,mutation_count FROM conversation_source_versions WHERE session_id=? AND epoch=? AND sequence=?'
    )
    .get(source.sessionId, source.epoch, source.sequence)
  if (
    prior &&
    (prior.sha256 !== input.sha256 ||
      prior.byte_length !== input.byteLength ||
      prior.row_kind !== input.kind ||
      prior.mutation_count !== input.mutationCount)
  ) {
    throw new ConversationRefusal('corrupt-record')
  }
  db.prepare('INSERT OR IGNORE INTO conversation_source_versions VALUES(?,?,?,?,?,?,?)').run(
    source.sessionId,
    source.epoch,
    source.sequence,
    input.sha256,
    input.byteLength,
    input.kind,
    input.mutationCount
  )
}
