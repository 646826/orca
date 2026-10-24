import { createHash } from 'node:crypto'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  serializeJournalRow,
  type JournalItemRow,
  type JournalRow
} from '../agent-session-journal/journal-row-schema'

export function contextSourceRow(sequence = 1): JournalItemRow {
  return {
    kind: 'item',
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'e',
    seq: sequence,
    fence: 1,
    ts: sequence,
    itemId: `source-message-${sequence}`,
    revision: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'original' }] }
  }
}

export const contextSourceText = serializeJournalRow(contextSourceRow())

export function contextSourceArchive(
  sessionId: string,
  rows: readonly JournalRow[] = [contextSourceRow()]
) {
  let text = ''
  const sources = rows.map((row) => {
    const source = { sessionId, epoch: row.epoch, sequence: row.seq }
    const raw = serializeJournalRow(row)
    const byteLength = Buffer.byteLength(raw)
    const frameOffset = Buffer.byteLength(text)
    text += `${JSON.stringify({ format: 'orca-canonical-row-v1', source, byteLength })}\n`
    const byteOffset = Buffer.byteLength(text)
    text += `${raw}\n`
    return { frameOffset, byteOffset, byteLength }
  })
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    byteLength: Buffer.byteLength(text),
    sources
  }
}
