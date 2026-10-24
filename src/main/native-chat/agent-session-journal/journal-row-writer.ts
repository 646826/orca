import type Database from '../../sqlite/sync-database'
import { insertJournalRow, readJournalSessionEpoch, readJournalTail } from './journal-row-table'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import { JournalWriteQueue, assertJournalSynchronousResult } from './journal-write-queue'
import { captureQueuedJournalRowEvidence } from './queued-message-origin'
import { notifyJournalCommitted } from './journal-commit-publication'

import {
  JournalCommittedWriteError,
  type JournalOperationReceipt,
  type JournalRowBuilder,
  type JournalRowWriterDeps,
  type PreparedRows,
  type CompoundRows,
  type CompoundPlan
} from './journal-row-writer-contracts'
export {
  JournalCommittedWriteError,
  composeJournalOperationReceipts,
  writeReceiptIfChanged,
  type JournalRowRestatement,
  type JournalRowTransactionHook,
  type JournalOperationReceipt,
  type JournalRowBuilder,
  type JournalRowWriterDeps
} from './journal-row-writer-contracts'

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(build: JournalRowBuilder, receipt?: JournalOperationReceipt): Promise<JournalRow> {
    return this.deps.serialize(
      () =>
        this.writeRows(
          () => [build],
          receipt,
          (rows) => rows[0]
        )[0]
    )
  }

  enqueueRows(
    plan: () => readonly JournalRowBuilder[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    return this.deps.serialize(() => this.writeRows(plan, receipt, receiptRow))
  }

  /** For an existing collaborator already running at its own turn in the lane. */
  writeRows(
    plan: () => readonly JournalRowBuilder[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): JournalRow[] {
    const prepared = this.prepareRows(plan, receipt, receiptRow)
    if (prepared.rows.length === 0) {
      return prepared.rows
    }
    try {
      this.deps.database().transaction(
        (db) => {
          this.insertPrepared(db, prepared)
          this.provePrepared(db, prepared)
        },
        !receipt && !this.deps.requiredInTransaction && this.streamed(prepared.rows)
      )
    } catch (error) {
      this.rollbackPrepared(prepared)
      throw error
    }
    try {
      assertJournalSynchronousResult(receipt?.committed())
      this.adoptPrepared(prepared)
    } catch (error) {
      this.deps.queue?.poison(error)
      throw new JournalCommittedWriteError(error)
    }
    notifyJournalCommitted(this.deps.notifyCommitted)
    return prepared.rows
  }

  /** The only multi-writer entry owns every lane; the prepare/write/adopt phases stay private. */
  static enqueueCompound(
    writers: readonly JournalRowWriter[],
    plan: () => CompoundPlan,
    options: { validateOwnership: () => void; signal?: AbortSignal }
  ): Promise<CompoundRows[]> {
    try {
      const ordered = [...writers].sort((a, b) => a.deps.sessionId.localeCompare(b.deps.sessionId))
      const database = ordered[0]?.deps.database()
      if (
        !database ||
        new Set(ordered.map((writer) => writer.deps.sessionId)).size !== ordered.length
      ) {
        throw new Error('compound journals must name distinct sessions on one host')
      }
      const queues = ordered.map((writer) => {
        if (
          writer.deps.database() !== database ||
          !writer.deps.queue ||
          !writer.deps.epoch ||
          !writer.deps.lastRowFence
        ) {
          throw new Error('compound journals must share the identical owned host database')
        }
        assertJournalWritable(writer.deps.readOnly(), writer.deps.sessionId)
        return writer.deps.queue
      })
      assertJournalSynchronousResult(options.validateOwnership())
      return JournalWriteQueue.serializeTogether(
        queues,
        () => {
          assertJournalSynchronousResult(options.validateOwnership())
          const planned = plan()
          assertJournalSynchronousResult(planned)
          const named = planned.appends.map(({ writer }) => writer)
          if (
            new Set(named).size !== named.length ||
            named.some((writer) => !writers.includes(writer))
          ) {
            throw new Error('compound appends must name distinct admitted journal handles')
          }
          const prepared = planned.appends.map((append) => ({
            writer: append.writer,
            prepared: append.writer.prepareRows(
              () => append.rows,
              append.receipt,
              append.receiptRow
            )
          }))
          const result = prepared.map(({ writer, prepared }) => ({ writer, rows: prepared.rows }))
          const receiptRow = planned.receiptRow?.(result)
          assertJournalSynchronousResult(receiptRow)
          if (
            (receiptRow && !result.some(({ rows }) => rows.includes(receiptRow))) ||
            prepared.some(
              ({ prepared }) => prepared.receiptRow && !prepared.rows.includes(prepared.receiptRow)
            )
          ) {
            throw new Error('compound receipts must select a row prepared by their owned append')
          }
          const coordinates = ordered.map((writer) => ({
            writer,
            prepared:
              prepared.find((entry) => entry.writer === writer)?.prepared ??
              writer.prepareRows(() => [])
          }))
          if (
            prepared.every(({ prepared }) => prepared.rows.length === 0 && !prepared.receipt) &&
            !planned.receipt &&
            !planned.validate
          ) {
            return result
          }
          try {
            database.transaction((db) => {
              assertJournalSynchronousResult(options.validateOwnership())
              for (const entry of coordinates) {
                entry.writer.assertPreparedTail(db, entry.prepared)
              }
              assertJournalSynchronousResult(planned.validate?.(db))
              for (const entry of prepared) {
                entry.writer.insertPrepared(db, entry.prepared)
              }
              assertJournalSynchronousResult(planned.receipt?.write(db, receiptRow))
              for (const entry of prepared) {
                entry.writer.provePrepared(db, entry.prepared)
              }
            })
          } catch (error) {
            for (const entry of coordinates) {
              entry.writer.rollbackPrepared(entry.prepared)
            }
            try {
              assertJournalSynchronousResult(planned.receipt?.rolledBack?.())
            } catch (rollbackError) {
              for (const queue of queues) {
                queue.poison(rollbackError)
              }
            }
            throw error
          }
          try {
            for (const entry of prepared) {
              assertJournalSynchronousResult(entry.prepared.receipt?.committed())
            }
            assertJournalSynchronousResult(planned.receipt?.committed())
            for (const entry of prepared) {
              entry.writer.adoptPrepared(entry.prepared)
            }
          } catch (error) {
            for (const queue of queues) {
              queue.poison(error)
            }
            throw new JournalCommittedWriteError(error)
          }
          for (const entry of prepared) {
            if (entry.prepared.rows.length > 0 || entry.prepared.receipt) {
              notifyJournalCommitted(entry.writer.deps.notifyCommitted)
            }
          }
          return result
        },
        options.signal
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  append(build: JournalRowBuilder, receipt?: JournalOperationReceipt): Promise<AgentJournalCursor> {
    return this.enqueue(build, receipt).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  private prepareRows(
    plan: () => readonly JournalRowBuilder[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): PreparedRows {
    assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
    const first = this.deps.nextSequence()
    const savedAt = this.deps.now()
    const fence = this.deps.highestFence()
    const builders = plan()
    assertJournalSynchronousResult(builders)
    const rows = builders.map((build, index) => {
      const row = build(first + index, savedAt)
      assertJournalSynchronousResult(row)
      assertJournalFence(row.fence, fence)
      return row
    })
    const selected = receiptRow?.(rows)
    assertJournalSynchronousResult(selected)
    return {
      rows,
      savedAt,
      epoch: this.deps.epoch?.() ?? rows[0]?.epoch ?? '',
      sequence: first - 1,
      fence,
      lastRowFence: this.deps.lastRowFence?.(),
      receipt,
      receiptRow: selected
    }
  }

  private assertPreparedTail(db: Database.Database, prepared: PreparedRows): void {
    const { sessionId } = this.deps
    const tail = readJournalTail(db, sessionId, prepared.epoch)
    if (
      readJournalSessionEpoch(db, sessionId) !== prepared.epoch ||
      tail.sequence !== prepared.sequence ||
      tail.fence !== prepared.lastRowFence ||
      this.deps.nextSequence() !== prepared.sequence + 1 ||
      this.deps.highestFence() !== prepared.fence ||
      this.deps.lastRowFence?.() !== prepared.lastRowFence ||
      prepared.rows.some(
        (row, index) => row.epoch !== prepared.epoch || row.seq !== prepared.sequence + index + 1
      )
    ) {
      const error = new Error(
        `journal ${sessionId} durable epoch, tail or fence changed; replay required`
      )
      this.deps.queue?.poison(error)
      throw error
    }
  }

  private insertPrepared(db: Database.Database, prepared: PreparedRows): void {
    for (const row of prepared.rows) {
      insertJournalRow(db, this.deps.sessionId, row, prepared.savedAt)
    }
    assertJournalSynchronousResult(prepared.receipt?.write(db, prepared.receiptRow))
  }

  private provePrepared(db: Database.Database, prepared: PreparedRows): void {
    for (const row of prepared.rows) {
      captureQueuedJournalRowEvidence(db, this.deps.sessionId, row)
      assertJournalSynchronousResult(this.deps.requiredInTransaction?.(db, row))
    }
  }

  private adoptPrepared(prepared: PreparedRows): void {
    if (prepared.rows.length > 0) {
      assertJournalSynchronousResult(this.deps.commit(prepared.rows, prepared.savedAt))
    }
  }

  private rollbackPrepared(prepared: PreparedRows): void {
    for (const rollback of [
      () => prepared.receipt?.rolledBack?.(),
      () => this.deps.rolledBack?.()
    ]) {
      try {
        assertJournalSynchronousResult(rollback())
      } catch (error) {
        this.deps.queue?.poison(error)
      }
    }
  }

  private streamed(rows: readonly JournalRow[]): boolean {
    const { streamedTextRevision } = this.deps
    return streamedTextRevision !== undefined && rows.every((row) => streamedTextRevision(row))
  }
}
