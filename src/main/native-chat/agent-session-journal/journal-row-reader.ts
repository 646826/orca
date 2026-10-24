import type Database from '../../sqlite/sync-database'

export type JournalStoredRow = { epoch: string; seq: number; ts: number; rowJson: string }

const SELECT_ROWS_AFTER = `SELECT seq, ts, row_json FROM journal_rows
WHERE session_id = ? AND epoch = ? AND seq > ? ORDER BY seq ASC`
const SELECT_ROWS_AFTER_LIMITED = `${SELECT_ROWS_AFTER} LIMIT ?`

export function readJournalRowsAfter(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSeq: number,
  limit?: number
): JournalStoredRow[] {
  const rows =
    limit !== undefined
      ? db.prepare(SELECT_ROWS_AFTER_LIMITED).all(sessionId, epoch, afterSeq, limit)
      : db.prepare(SELECT_ROWS_AFTER).all(sessionId, epoch, afterSeq)
  return rows.flatMap((row) =>
    typeof row.seq === 'number' && typeof row.ts === 'number' && typeof row.row_json === 'string'
      ? [{ epoch, seq: row.seq, ts: row.ts, rowJson: row.row_json }]
      : []
  )
}
