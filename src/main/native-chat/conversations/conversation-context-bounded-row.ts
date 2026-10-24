import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  parseJournalRow,
  type JournalRow
} from '../agent-session-journal/journal-row-schema'
import { ConversationExportError } from './conversation-export-error'

type RowProjection = {
  write: (text: string) => void
  end: () => { row: JournalRow; substitutedPaths: string[] }
}
/** Exact bounded batch parsing preserves normalized-size validation; no nested string substitutions. */
export function boundedLifecycleProjection(
  byteLength: number | undefined,
  fallback: () => RowProjection
): RowProjection {
  if (byteLength === undefined || byteLength > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) {
    return fallback()
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new ConversationExportError('resource-limit')
  }
  const chunks: string[] = []
  let length = 0,
    finished = false
  return {
    write(text) {
      if (finished) {
        throw new ConversationExportError('corrupt-source')
      }
      if (text.length === 0) {
        return
      }
      if (chunks.length >= 32768) {
        throw new ConversationExportError('resource-limit')
      }
      length += text.length
      if (length > byteLength) {
        throw new ConversationExportError('resource-limit')
      }
      chunks.push(text)
    },
    end() {
      if (finished) {
        throw new ConversationExportError('corrupt-source')
      }
      finished = true
      const raw = chunks.join('')
      if (Buffer.byteLength(raw) !== byteLength) {
        throw new ConversationExportError('corrupt-source')
      }
      const parsed = parseJournalRow(raw)
      if (!parsed.ok) {
        throw new ConversationExportError(parsed.unreadable ? 'newer-schema' : 'corrupt-source')
      }
      if (parsed.row.kind === 'lifecycle-batch') {
        return { row: parsed.row, substitutedPaths: [] }
      }
      const projection = fallback()
      for (const chunk of chunks) {
        projection.write(chunk)
      }
      return projection.end()
    }
  }
}
