import { createHash } from 'node:crypto'
import type Database from '../../src/main/sqlite/sync-database'
import { conversationBenchmarkRows } from './conversation-context-benchmark-rows.mjs'
import { parseJournalRow } from '../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { insertJournalRow } from '../../src/main/native-chat/agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../src/shared/agent-session-journal-types'
export const BENCHMARK_CONSTRAINT = 'Never delete the final constraint.'
export function seedPreparationBenchmarkRows(
  db: Database.Database,
  input: { eventCount: number; requiredTextBytes?: number; toolRowBytes?: number },
  sourceCount: number
) {
  for (const raw of conversationBenchmarkRows(
    input.eventCount,
    AGENT_SESSION_JOURNAL_SCHEMA_VERSION
  )) {
    const parsed = parseJournalRow(JSON.stringify(raw))
    if (!parsed.ok) {
      throw new Error('Benchmark generated invalid canonical row')
    }
    insertJournalRow(db, 'synthetic-session', parsed.row)
  }
  if (input.requiredTextBytes) {
    insertJournalRow(db, 'synthetic-session', {
      kind: 'item',
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'synthetic',
      seq: input.eventCount + 2,
      ts: sourceCount,
      fence: 1,
      itemId: 'mandatory-large',
      revision: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `${'x'.repeat(input.requiredTextBytes)}${BENCHMARK_CONSTRAINT}`
          }
        ]
      }
    })
  }

  if (input.toolRowBytes) {
    const row = {
      kind: 'item' as const,
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'synthetic',
      seq: sourceCount,
      ts: sourceCount,
      fence: 1,
      itemId: 'large-tool',
      revision: 1,
      body: {
        kind: 'tool-call' as const,
        name: 'Read',
        state: 'done' as const,
        input: 'synthetic',
        output: {
          head: '',
          byteLength: input.toolRowBytes,
          digest: '0'.repeat(64),
          truncated: false
        }
      }
    }
    const suffix = '日本語🙂終端'
    const available =
      input.toolRowBytes - Buffer.byteLength(JSON.stringify(row)) - Buffer.byteLength(suffix)
    if (available < 0) {
      throw new RangeError('Tool row size too small')
    }
    const unit = '日本語🙂'
    row.body.output.head =
      unit.repeat(Math.floor(available / Buffer.byteLength(unit))) +
      'x'.repeat(available % Buffer.byteLength(unit)) +
      suffix
    row.body.output.byteLength = Buffer.byteLength(row.body.output.head)
    row.body.output.digest = createHash('sha256').update(row.body.output.head).digest('hex')
    const serialized = JSON.stringify(row)
    const parsed = parseJournalRow(serialized)
    if (
      Buffer.byteLength(serialized) !== input.toolRowBytes ||
      !parsed.ok ||
      JSON.stringify(parsed.row) !== serialized
    ) {
      throw new Error('Invalid sized canonical tool fixture')
    }
    insertJournalRow(db, 'synthetic-session', parsed.row)
  }
}
