import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { ConversationReducerDiskItems } from './conversation-reducer-disk-map'
export class ConversationReplayScratch {
  readonly items: ConversationReducerDiskItems
  private readonly db: Database.Database
  private readonly directory: string
  private closed = false
  private databaseClosed = false
  private directoryRemoved = false
  constructor(scratchDirectory: string) {
    this.directory = mkdtempSync(join(scratchDirectory, 'conversation-replay-'))
    const path = join(this.directory, 'projection.sqlite')
    let opened: Database.Database | undefined
    try {
      opened = new Database(path)
      this.db = opened
      hardenSqliteDatabaseFiles(path)
      this.items = new ConversationReducerDiskItems(this.db)
    } catch (error) {
      opened?.close()
      rmSync(this.directory, { recursive: true, force: true })
      throw error
    }
  }
  batch(run: () => void): void {
    if (this.databaseClosed) {
      throw new Error('Presentation replay is closed')
    }
    runJournalTransaction(this.db, run)
  }
  close(): void {
    if (this.closed) {
      return
    }
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
    this.closed = true
  }
}
