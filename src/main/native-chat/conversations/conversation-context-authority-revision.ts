import type Database from '../../sqlite/sync-database'

/** Conservative invalidation: unrelated export activity can require preparation to retry. */
export function createConversationAuthorityRevisionTablesSql(): string {
  const tables = [
    'conversation_attachment_claims',
    'conversation_export_sources',
    'conversation_export_disclosures',
    'conversation_source_atoms',
    'conversation_source_attribution',
    'conversation_source_versions',
    'conversation_segments',
    'conversation_participants',
    'conversation_origin_rows',
    'conversation_pending_native_identity',
    'conversation_origin_batch_envelopes',
    'conversation_origin_bindings',
    'conversation_origin_acquisitions',
    'conversation_origin_enrollments',
    'conversation_origin_correlations'
  ]
  return `CREATE TABLE IF NOT EXISTS conversation_context_authority_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
 INSERT OR IGNORE INTO conversation_context_authority_revision VALUES(1,0);
 ${tables
   .flatMap((table) =>
     ['INSERT', 'UPDATE', 'DELETE'].map(
       (
         event
       ) => `CREATE TRIGGER IF NOT EXISTS ${table}_context_revision_${event.toLowerCase()} AFTER ${event} ON ${table}
 BEGIN UPDATE conversation_context_authority_revision SET revision=revision+1 WHERE id=1; END;`
     )
   )
   .join('\n')}
 ${['UPDATE', 'DELETE'].map((event) => `CREATE TRIGGER IF NOT EXISTS journal_epoch_pins_context_revision_${event.toLowerCase()} AFTER ${event} ON journal_epoch_pins BEGIN UPDATE conversation_context_authority_revision SET revision=revision+1 WHERE id=1; END;`).join('\n')}
 CREATE TABLE IF NOT EXISTS conversation_context_coverage_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
 INSERT OR IGNORE INTO conversation_context_coverage_revision VALUES(1,0);
 ${['conversation_context_coverage', 'conversation_context_index_receipts']
   .flatMap((table) =>
     ['INSERT', 'UPDATE', 'DELETE'].map(
       (
         event
       ) => `CREATE TRIGGER IF NOT EXISTS ${table}_coverage_revision_${event.toLowerCase()} AFTER ${event} ON ${table}
 BEGIN UPDATE conversation_context_coverage_revision SET revision=revision+1 WHERE id=1; END;`
     )
   )
   .join('\n')}`
}
export function readConversationAuthorityRevision(db: Database.Database): number {
  const value = db
    .prepare('SELECT revision FROM conversation_context_authority_revision WHERE id=1')
    .get()?.revision
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid context authority revision')
  }
  return value
}
export class ConversationAuthorityRevisionChangedError extends Error {
  constructor() {
    super('Context authority changed during preparation')
    this.name = 'ConversationAuthorityRevisionChangedError'
  }
}

export function assertConversationAuthorityRevision(db: Database.Database, expected: number): void {
  if (readConversationAuthorityRevision(db) !== expected) {
    throw new ConversationAuthorityRevisionChangedError()
  }
}

/** Prior-delivery changes invalidate assignments without invalidating sealed source authorization. */
export function readConversationCoverageRevision(db: Database.Database): number {
  const value = db
    .prepare('SELECT revision FROM conversation_context_coverage_revision WHERE id=1')
    .get()?.revision
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid context coverage revision')
  }
  return value
}
export function assertConversationCoverageRevision(db: Database.Database, expected: number): void {
  if (readConversationCoverageRevision(db) !== expected) {
    throw new Error('Context coverage changed during preparation')
  }
}
