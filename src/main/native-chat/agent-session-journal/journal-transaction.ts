import type Database from '../../sqlite/sync-database'

/**
 * One IMMEDIATE transaction, its COMMIT inside the failure boundary: SQLite can leave a transaction
 * open after a failed COMMIT, and on the shared connection every later BEGIN would then fail. The
 * caller gets the original error; a ROLLBACK that fails too goes to `onStranded`. `run` is
 * synchronous by contract: an await inside it would let another chat's statements land in this
 * transaction.
 */
export function runJournalTransaction<T>(
  db: Database.Database,
  run: (db: Database.Database) => T,
  onStranded: () => void = () => undefined
): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run(db)
    if (result instanceof Promise) {
      throw new Error('a chat journal transaction must not await')
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        console.warn(
          '[agent-session-journal] rolling back a failed transaction failed',
          rollbackError
        )
        onStranded()
      }
    }
    throw error
  }
}
