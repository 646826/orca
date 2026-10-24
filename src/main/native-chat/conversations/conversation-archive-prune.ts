import type Database from '../../sqlite/sync-database'

/** Shared epochs remain intact; a retired unclaimed epoch is reclaimed in at most 128 rows. */
export function pruneConversationArchiveEpoch(
  db: Database.Database,
  operationKey: string
): boolean {
  if (!db.isTransaction) {
    throw new Error('Archive prune requires transaction')
  }
  const epoch = db
    .prepare(
      'SELECT session_id,epoch FROM conversation_archive_epochs WHERE operation_key=? ORDER BY session_id,epoch LIMIT 1'
    )
    .get(operationKey)
  if (!epoch) {
    return true
  }
  if (typeof epoch.session_id !== 'string' || typeof epoch.epoch !== 'string') {
    throw new Error('Invalid archive epoch')
  }
  const protectedEpoch = db
    .prepare(
      'SELECT 1 FROM journal_epoch_pins WHERE session_id=? AND epoch=? UNION ALL SELECT 1 FROM journal_sessions WHERE session_id=? AND epoch=? LIMIT 1'
    )
    .get(epoch.session_id, epoch.epoch, epoch.session_id, epoch.epoch)
  if (!protectedEpoch) {
    db.prepare(
      'DELETE FROM journal_rows WHERE session_id=? AND epoch=? AND seq IN (SELECT seq FROM journal_rows WHERE session_id=? AND epoch=? ORDER BY seq LIMIT 128)'
    ).run(epoch.session_id, epoch.epoch, epoch.session_id, epoch.epoch)
    if (
      db
        .prepare('SELECT 1 FROM journal_rows WHERE session_id=? AND epoch=? LIMIT 1')
        .get(epoch.session_id, epoch.epoch)
    ) {
      return false
    }
  }
  db.prepare(
    'DELETE FROM conversation_archive_epochs WHERE operation_key=? AND session_id=? AND epoch=?'
  ).run(operationKey, epoch.session_id, epoch.epoch)
  return false
}
