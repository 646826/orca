import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { isAdmissibleAgentJournalRenderItem } from '../../../shared/agent-session-journal-schemas'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type {
  ConversationHistoricalPage,
  ConversationHistoryCursor
} from '../../../shared/conversation-rpc'

/** Disposable projection only; retained journal rows remain the source of truth. */
export class ConversationHistoryIndex {
  private readonly directory: string
  private readonly db: Database.Database
  private databaseClosed = false
  private directoryRemoved = false
  constructor(root: string) {
    this.directory = mkdtempSync(join(root, 'conversation-history-'))
    const path = join(this.directory, 'projection.sqlite')
    let opened: Database.Database | undefined
    try {
      opened = new Database(path)
      this.db = opened
      hardenSqliteDatabaseFiles(path)
      this.db
        .exec(`CREATE TABLE positions(item_id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL UNIQUE,segment_id TEXT NOT NULL,epoch TEXT NOT NULL,sequence INTEGER NOT NULL);
   CREATE TABLE visible(item_id TEXT PRIMARY KEY,item_json TEXT NOT NULL,epoch TEXT NOT NULL,sequence INTEGER NOT NULL);`)
    } catch (error) {
      opened?.close()
      rmSync(this.directory, { recursive: true, force: true })
      throw error
    }
  }
  flush(): void {
    if (this.db.isTransaction) {
      this.db.exec('COMMIT')
    }
  }
  beginEpoch(): void {
    this.flush()
    this.db.exec('BEGIN')
    this.db.exec('DELETE FROM visible')
  }
  append(item: AgentJournalRenderItem, segmentId: string, epoch: string): void {
    if (!this.db.isTransaction) {
      this.db.exec('BEGIN')
    }
    const prior = this.db
      .prepare('SELECT segment_id FROM positions WHERE item_id=?')
      .get(item.itemId)
    if (prior && prior.segment_id !== segmentId) {
      throw new Error('Historical item origin changed')
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO positions SELECT ?,COALESCE(MAX(ordinal),0)+1,?,?,? FROM positions`
      )
      .run(item.itemId, segmentId, epoch, item.sequence)
    this.db
      .prepare('INSERT INTO visible VALUES(?,?,?,?)')
      .run(item.itemId, JSON.stringify(item), epoch, item.sequence)
  }
  page(input: {
    segmentId: string
    sessionId: string
    provider: string
    sourceRevision: string
    after: ConversationHistoryCursor | null
    direction?: 'forward' | 'backward'
    limit: number
    byteLimit: number
  }): ConversationHistoricalPage {
    const result: ConversationHistoricalPage = {
      segmentId: input.segmentId,
      sourceRevision: input.sourceRevision,
      readOnly: true,
      items: [],
      next: input.after,
      status: 'complete'
    }
    const backward = input.direction === 'backward'
    const finish = () => {
      if (backward) {
        result.items.reverse()
      }
      return result
    }
    const rows = this.db
      .prepare(`SELECT p.*,v.epoch latest_epoch,v.sequence latest_sequence,octet_length(v.item_json) bytes FROM positions p JOIN visible v USING(item_id)
   WHERE p.segment_id=? AND p.ordinal${backward ? '<' : '>'}? ORDER BY p.ordinal ${backward ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(
        input.segmentId,
        input.after?.ordinal ?? (backward ? Number.MAX_SAFE_INTEGER : 0),
        input.limit + 1
      )
    let bytes = Buffer.byteLength(
      JSON.stringify({
        ...result,
        status: 'resource-limit',
        next: {
          epochOrdinal: 1,
          sequence: Number.MAX_SAFE_INTEGER,
          index: 0,
          ordinal: Number.MAX_SAFE_INTEGER
        }
      })
    )
    for (const row of rows) {
      if (
        typeof row.ordinal !== 'number' ||
        typeof row.sequence !== 'number' ||
        typeof row.epoch !== 'string' ||
        typeof row.bytes !== 'number' ||
        typeof row.item_id !== 'string' ||
        typeof row.latest_epoch !== 'string' ||
        typeof row.latest_sequence !== 'number'
      ) {
        throw new Error('Historical projection corrupt')
      }
      if (result.items.length === input.limit || bytes + row.bytes > input.byteLimit) {
        result.status = result.items.length ? 'more' : 'resource-limit'
        return finish()
      }
      const raw = this.db
        .prepare('SELECT item_json FROM visible WHERE item_id=?')
        .get(row.item_id)?.item_json
      const item: unknown = typeof raw === 'string' ? JSON.parse(raw) : null
      if (!isAdmissibleAgentJournalRenderItem(item)) {
        throw new Error('Historical projection corrupt')
      }
      const entry = {
        segmentId: input.segmentId,
        provider: input.provider,
        originSource: { sessionId: input.sessionId, epoch: row.epoch, sequence: row.sequence },
        revisionEpoch: row.latest_epoch,
        item
      }
      const size = Buffer.byteLength(JSON.stringify(entry))
      if (bytes + size + 1 > input.byteLimit) {
        result.status = result.items.length ? 'more' : 'resource-limit'
        return finish()
      }
      bytes += size + 1
      result.items.push(entry)
      result.next = { epochOrdinal: 1, sequence: row.sequence, index: 0, ordinal: row.ordinal }
    }
    result.next = null
    return finish()
  }
  close(): void {
    if (!this.databaseClosed) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      this.db.close()
      this.databaseClosed = true
    }
    if (!this.directoryRemoved) {
      rmSync(this.directory, { recursive: true, force: true })
      this.directoryRemoved = true
    }
  }
}
