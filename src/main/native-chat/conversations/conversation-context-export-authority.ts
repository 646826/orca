import { readConversationSourceSegmentId } from './conversation-source-attribution'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import type {
  ConversationExportedRow,
  ConversationExportSelection
} from './conversation-context-export'
import {
  recordConversationSourceVersion,
  authorizeConversationSourceAtoms
} from './conversation-source-atoms'
import {
  assertConversationExportScope,
  ConversationExportError,
  type ConversationExportScope
} from './conversation-artifact-disclosure'

export function assertConversationExportSource(
  input: ConversationExportScope,
  selection: ConversationExportSelection
): void {
  assertConversationExportScope(input, selection.segmentId)
  const { source } = selection
  if (
    !Number.isSafeInteger(source.sequence) ||
    source.sequence < 1 ||
    source.batchIndex !== undefined
  ) {
    throw new ConversationExportError('scope')
  }
  if (readConversationSourceSegmentId(input.db, source) !== selection.segmentId) {
    throw new ConversationExportError('scope')
  }
  const pin = input.db
    .prepare(
      'SELECT end_sequence FROM journal_epoch_pins WHERE owner_id=? AND session_id=? AND epoch=?'
    )
    .get(selection.pinOwnerId, source.sessionId, source.epoch)
  if (typeof pin?.end_sequence !== 'number' || pin.end_sequence < source.sequence) {
    throw new ConversationExportError('missing-source')
  }
}

export function recordExportSourceVersions(
  input: ConversationExportScope,
  pins: readonly JournalEpochPin[],
  rows: readonly ConversationExportedRow[]
): void {
  for (const row of rows) {
    const source = {
      sessionId: row.version.source.sessionId,
      epoch: row.version.source.epoch,
      sequence: row.version.source.sequence
    }
    const pin = pins.find((pin) => pin.sessionId === source.sessionId && pin.epoch === source.epoch)
    if (!pin) {
      throw new ConversationExportError('missing-source')
    }
    recordConversationSourceVersion(input.db, {
      pin,
      source,
      sha256: row.version.sha256,
      byteLength: row.byteLength,
      kind: row.kind,
      mutationCount: row.mutationCount
    })
    if (
      row.mutationCount > 0 &&
      !authorizeConversationSourceAtoms(input.db, {
        conversationId: input.conversationId,
        contextGeneration: input.contextGeneration,
        source,
        sha256: row.version.sha256,
        mutationCount: row.mutationCount
      })
    ) {
      throw new ConversationExportError('scope')
    }
  }
}

export function assertUniqueExportSources(sources: readonly ConversationExportSelection[]): void {
  const seen = new Set<string>()
  for (const selected of sources) {
    const key = JSON.stringify([
      selected.source.sessionId,
      selected.source.epoch,
      selected.source.sequence
    ])
    if (seen.has(key)) {
      throw new ConversationExportError('scope')
    }
    seen.add(key)
  }
}
