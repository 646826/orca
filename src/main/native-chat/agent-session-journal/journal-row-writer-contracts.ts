import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import type { JournalRowWriter } from './journal-row-writer'
import {
  assertJournalSynchronousResult,
  type JournalWriteQueue,
  type JournalWriteBody
} from './journal-write-queue'

export type JournalRowRestatement = {
  previousSource: { epoch: string; sequence: number; batchIndex?: number }
}
export type JournalRowTransactionHook = (
  db: Database.Database,
  row: JournalRow,
  restatement?: JournalRowRestatement
) => void

/** `write` runs in the row's transaction; `committed` adopts synchronously without notifying. */
export type JournalOperationReceipt = {
  write: (db: Database.Database, row?: JournalRow) => void
  committed: () => void
  rolledBack?: () => void
}

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  return {
    write: (db, row) =>
      receipts.forEach((receipt) => assertJournalSynchronousResult(receipt.write(db, row))),
    committed: () =>
      receipts.forEach((receipt) => assertJournalSynchronousResult(receipt.committed())),
    rolledBack: () => {
      const failures: unknown[] = []
      for (const receipt of receipts) {
        try {
          assertJournalSynchronousResult(receipt.rolledBack?.())
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) {
        throw failures[0]
      }
    }
  }
}

export function writeReceiptIfChanged<T>(
  run: (db: Database.Database) => T,
  changed: (result: T) => boolean,
  receipt?: JournalOperationReceipt
): (db: Database.Database) => T {
  return (db) => {
    const result = run(db)
    if (receipt && changed(result)) {
      assertJournalSynchronousResult(receipt.write(db))
    }
    return result
  }
}

export type JournalRowBuilder = (seq: number, ts: number) => JournalRow
export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  commit: (rows: readonly JournalRow[], savedAt: number) => void
  notifyCommitted?: () => void
  queue?: JournalWriteQueue
  epoch?: () => string
  lastRowFence?: () => number
  requiredInTransaction?: JournalRowTransactionHook
  rolledBack?: () => void
  streamedTextRevision?: (row: JournalRow) => boolean
}

export type PreparedRows = {
  rows: JournalRow[]
  savedAt: number
  epoch: string
  sequence: number
  fence: number
  lastRowFence: number | undefined
  receipt?: JournalOperationReceipt
  receiptRow?: JournalRow
}

export type CompoundRows = { writer: JournalRowWriter; rows: JournalRow[] }
export type CompoundPlan = {
  appends: readonly {
    writer: JournalRowWriter
    rows: readonly JournalRowBuilder[]
    receipt?: JournalOperationReceipt
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  }[]
  receipt?: JournalOperationReceipt
  receiptRow?: (prepared: readonly CompoundRows[]) => JournalRow | undefined
  validate?: (db: Database.Database) => void
}

export { JournalCommittedWriteError } from './journal-commit-publication'
