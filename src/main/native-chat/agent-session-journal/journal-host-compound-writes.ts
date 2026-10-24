import type Database from '../../sqlite/sync-database'
import type { JournalRow } from './journal-row-schema'
import {
  JournalRowWriter,
  type JournalOperationReceipt,
  type JournalRowBuilder
} from './journal-row-writer'
import type { AgentSessionJournal } from './journal-store'
import { assertJournalSynchronousResult } from './journal-write-queue'

export type JournalHostCompoundRows = {
  journal: AgentSessionJournal
  rows: JournalRow[]
}

export type JournalHostCompoundPlan = {
  appends: readonly {
    journal: AgentSessionJournal
    rows: readonly JournalRowBuilder[]
    /** Journal metadata only; store mutations belong to the ONE shared receipt below. */
    receipt?: JournalOperationReceipt
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  }[]
  /** Compose all store mutations into one draft, never independently staged store receipts. */
  receipt?: JournalOperationReceipt
  receiptRow?: (prepared: readonly JournalHostCompoundRows[]) => JournalRow | undefined
  validate?: (db: Database.Database) => void
}

const writers = new WeakMap<AgentSessionJournal, JournalRowWriter>()

/** Constructor wiring only: no mutable writer capability is returned to a journal caller. */
export function registerJournalCompoundWriter(
  journal: AgentSessionJournal,
  writer: JournalRowWriter
): void {
  if (writers.has(journal)) {
    throw new Error('journal compound writer already registered')
  }
  writers.set(journal, writer)
}

/** Results preserve `appends` order. Planning owns every lane; no public append may be nested. */
export function appendJournalHostCompound(
  participants: readonly AgentSessionJournal[],
  plan: () => JournalHostCompoundPlan,
  options: {
    /** The host's authoritative live-handle lookup, not an epoch or session-id comparison. */
    isCurrent: (journal: AgentSessionJournal) => boolean
    signal?: AbortSignal
  }
): Promise<JournalHostCompoundRows[]> {
  try {
    const admitted = new Map<AgentSessionJournal, JournalRowWriter>()
    const journals = new Map<JournalRowWriter, AgentSessionJournal>()
    for (const journal of participants) {
      const writer = writers.get(journal)
      if (!writer || admitted.has(journal)) {
        throw new Error('compound journal participants must be distinct registered handles')
      }
      admitted.set(journal, writer)
      journals.set(writer, journal)
    }
    const identify = (prepared: readonly { writer: JournalRowWriter; rows: JournalRow[] }[]) =>
      prepared.map(({ writer, rows }) => {
        const journal = journals.get(writer)
        if (!journal) {
          throw new Error('compound append escaped its admitted journals')
        }
        return { journal, rows }
      })
    return JournalRowWriter.enqueueCompound(
      [...admitted.values()],
      () => {
        const planned = plan()
        assertJournalSynchronousResult(planned)
        return {
          ...planned,
          appends: planned.appends.map(({ journal, ...append }) => {
            const writer = admitted.get(journal)
            if (!writer) {
              throw new Error('compound append names a journal outside its admitted lanes')
            }
            return { writer, ...append }
          }),
          receiptRow: planned.receiptRow
            ? (prepared) => planned.receiptRow?.(identify(prepared))
            : undefined
        }
      },
      {
        signal: options.signal,
        validateOwnership: () => {
          for (const journal of participants) {
            const current = options.isCurrent(journal)
            assertJournalSynchronousResult(current)
            if (current !== true) {
              throw new Error('compound journal handle is no longer the host owner')
            }
          }
        }
      }
    ).then(identify)
  } catch (error) {
    return Promise.reject(error)
  }
}
