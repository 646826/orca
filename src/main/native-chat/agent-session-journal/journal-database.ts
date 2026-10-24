import { runJournalTransaction } from './journal-transaction'
export { runJournalTransaction } from './journal-transaction'
import { createConversationTransferRecoveryTablesSql } from '../conversations/conversation-transfer-recovery-schema'
import { createConversationTransferNoWriteTablesSql } from '../conversations/conversation-transfer-no-write-schema'
import {
  createConversationArchiveTablesSql,
  createConversationArchiveLookupIndexesSql
} from '../conversations/conversation-archive-schema'
import { migrateQueuedMessageOrigins } from './queued-message-origin-schema'
import { createConversationClearTablesSql } from '../conversations/conversation-clear-schema'
import { createAgentSessionUploadProvenanceTablesSql } from '../agent-session-attachments/agent-session-upload-provenance'
import { createConversationTabSurfaceTablesSql } from '../conversations/conversation-tab-surface-schema'
import { createConversationEvidenceTrustTablesSql } from '../conversations/conversation-evidence-trust'
import { createConversationPreparationTablesSql } from '../conversations/conversation-preparation-schema'
import { createConversationPreparationRequestTablesSql } from '../conversations/conversation-preparation-request'
import { createConversationSourceProvenanceRevisionTablesSql } from '../conversations/conversation-source-provenance-revision'
import { createConversationDeliveryTablesSql } from '../conversations/conversation-delivery-schema'
import { createConversationOriginTablesSql } from '../conversations/conversation-origin-schema'
import { migrateConversationTriggerReservations } from '../conversations/conversation-trigger-schema'
import { createConversationTablesSql } from '../conversations/conversation-schema'
import { createConversationContextTablesSql } from '../conversations/conversation-context-schema'
import { createConversationSourceAtomTablesSql } from '../conversations/conversation-source-atoms'
import { createConversationExportProofTablesSql } from '../conversations/conversation-context-export-proof'
import { createConversationManifestPartTablesSql } from '../conversations/conversation-context-parts'
import { createConversationExportDisclosureTablesSql } from '../conversations/conversation-source-disclosure'
import { createConversationAuthorityRevisionTablesSql } from '../conversations/conversation-context-authority-revision'
import { createConversationManifestIndexAuthorityTablesSql } from '../conversations/conversation-context-index-authority'
import { createConversationIndexedCoverageTablesSql } from '../conversations/conversation-context-index-coverage'
// Opening the host's chat journal database.
//
// `PRAGMA user_version` is read FIRST, on a connection that has set no persistent pragma and run
// no DDL: a database written by a newer schema must be left byte-identical, and
// `journal_mode = WAL` writes the file header.

import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql,
  JOURNAL_DB_OLDEST_RELEASED_VERSION,
  JOURNAL_DB_SCHEMA_VERSION
} from './journal-database-schema'
import { JournalUnreleasedSchemaError } from './journal-open-failure'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import { ensureCommandReceiptsTable } from './command-receipt-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { createJournalEpochPinTablesSql } from './journal-epoch-pins'
import { ensureConversationAttachmentClaimTables } from '../agent-session-attachments/conversation-attachment-claims'

export const JOURNAL_BUSY_TIMEOUT_MS = 5000
/** Bounds the WAL a checkpoint leaves behind; SQLite truncates it back to this after a reset. */
export const JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024
/** Every commit is fsynced before its caller continues. */
const JOURNAL_SYNCHRONOUS = 'FULL'

export type OpenJournalDatabase = {
  db: Database.Database
  /** A newer `user_version` was met: this build reads and never writes. */
  readOnly: boolean
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

/** Whether the database holds any chat record or tab, read-only. */
export function journalDatabaseHoldsAgentSessions(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name)
    )
    return ['agent_session_records', 'agent_session_tabs'].some(
      (table) =>
        tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined
    )
  } finally {
    db.close()
  }
}

export type JournalMigrationGuard = (run: () => void) => void

export function openJournalDatabase(
  dbPath: string,
  withMigration?: JournalMigrationGuard
): OpenJournalDatabase {
  const probe = new Database(dbPath)
  let stored: number
  try {
    stored = journalPragmaNumber(probe, 'user_version')
  } catch (error) {
    probe.close()
    throw error
  }
  if (stored > JOURNAL_DB_SCHEMA_VERSION) {
    probe.close()
    return {
      db: new Database(dbPath, { readonly: true, fileMustExist: true }),
      readOnly: true
    }
  }
  let transferred = false
  try {
    let readOnly = false
    const initialize = () => {
      stored = journalPragmaNumber(probe, 'user_version')
      if (stored > JOURNAL_DB_SCHEMA_VERSION) {
        readOnly = true
        return
      }
      initializeWritableJournal(probe, dbPath, stored)
    }
    if (stored < JOURNAL_DB_SCHEMA_VERSION && withMigration) {
      runGuardedMigration(withMigration, initialize)
    } else {
      initialize()
    }
    if (readOnly) {
      return {
        db: new Database(dbPath, { readonly: true, fileMustExist: true }),
        readOnly: true
      }
    }
    transferred = true
    return { db: probe, readOnly: false }
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

function runGuardedMigration(guard: JournalMigrationGuard, initialize: () => void): void {
  let active = true
  let called = false
  let completed = false
  try {
    const result: unknown = guard(() => {
      if (!active || called) {
        throw new Error('journal migration guard must invoke its callback synchronously once')
      }
      called = true
      initialize()
      completed = true
    })
    if (!completed || result instanceof Promise) {
      throw new Error('journal migration guard must invoke its callback synchronously once')
    }
  } finally {
    active = false
  }
}

function initializeWritableJournal(db: Database.Database, dbPath: string, stored: number): void {
  if (stored !== 0 && stored < JOURNAL_DB_OLDEST_RELEASED_VERSION) {
    throw new JournalUnreleasedSchemaError(
      `chat journal ${dbPath} uses unreleased schema ${stored}, written by an unreleased development build of Orca. Orca can't load its chats. Moving the file aside lets Orca start a new one, but that loses every chat's history, tabs and ownership records stored in it.`
    )
  }
  configureJournalPragmas(db, stored)
  migrateJournalSchema(db, stored)
  ensureQueuedMessagesTable(db)
  ensureCommandReceiptsTable(db)
  ensureAgentSessionAttachmentClaimTables(db)
  hardenSqliteDatabaseFiles(dbPath)
}

function configureJournalPragmas(db: Database.Database, stored: number): void {
  if (stored === 0) {
    // Only takes on an empty file, and only before WAL, so it is set now: nothing reclaims pages
    // yet, but a later pass can free them in bounded steps rather than a full VACUUM.
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // Why FULL rather than the house NORMAL: NORMAL in WAL mode does not fsync at commit, and the
  // write-ahead submission row must be on disk before the adapter dispatches anything. FULL alone
  // does not survive power loss on macOS, whose fsync leaves the drive cache unflushed; checkpoint
  // fullfsync makes each checkpoint use F_FULLFSYNC (a no-op elsewhere).
  db.pragma(`synchronous = ${JOURNAL_SYNCHRONOUS}`)
  db.pragma('checkpoint_fullfsync = ON')
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`)
}

/**
 * Table creation and the `user_version` bump are ONE transaction: creating the tables first left a
 * shaped database still reporting version 0, which an older build does not latch read-only.
 */
function migrateJournalSchema(db: Database.Database, stored: number): void {
  if (stored >= JOURNAL_DB_SCHEMA_VERSION) {
    return
  }
  runJournalTransaction(db, () => {
    if (stored === 0) {
      db.exec(createJournalTablesSql())
    }
    db.exec(createAgentSessionRecordTablesSql())
    db.exec(createJournalEpochPinTablesSql())
    db.exec(createConversationTablesSql())
    db.exec(createConversationClearTablesSql())
    db.exec(createConversationArchiveTablesSql())
    db.exec(createConversationTabSurfaceTablesSql())
    db.exec(createAgentSessionUploadProvenanceTablesSql())
    ensureQueuedMessagesTable(db)
    migrateQueuedMessageOrigins(db)
    migrateConversationTriggerReservations(db)
    db.exec(createConversationOriginTablesSql())
    db.exec(createConversationEvidenceTrustTablesSql())
    db.exec(createConversationContextTablesSql())
    db.exec(createConversationDeliveryTablesSql())
    db.exec(createConversationTransferNoWriteTablesSql())
    db.exec(createConversationTransferRecoveryTablesSql())
    db.exec(createConversationPreparationTablesSql())
    db.exec(createConversationManifestPartTablesSql())
    db.exec(createConversationManifestIndexAuthorityTablesSql())
    db.exec(createConversationIndexedCoverageTablesSql())
    db.exec(createConversationSourceAtomTablesSql())
    ensureAgentSessionAttachmentClaimTables(db)
    ensureConversationAttachmentClaimTables(db)
    db.exec(createConversationExportProofTablesSql())
    db.exec(createConversationExportDisclosureTablesSql())
    db.exec(createConversationAuthorityRevisionTablesSql())
    db.exec(createConversationSourceProvenanceRevisionTablesSql())
    db.exec(createConversationPreparationRequestTablesSql())
    db.exec(createConversationArchiveLookupIndexesSql())
    // Prior writers cannot represent preallocated origins; unresolved legacy intents stay fenced.
    db.exec(
      "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.candidateSegmentId',NULL) WHERE json_type(record_json,'$.candidateSegmentId') IS NULL"
    )
    db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
  })
}
