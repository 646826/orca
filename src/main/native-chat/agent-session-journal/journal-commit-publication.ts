import { assertJournalSynchronousResult, type JournalWriteQueue } from './journal-write-queue'

export class JournalCommittedWriteError extends Error {
  readonly committed = true

  constructor(cause: unknown) {
    super('journal commit is durable; adoption failed and the handles require replay', { cause })
    this.name = 'JournalCommittedWriteError'
  }
}

export function failJournalCommittedAdoption(queue: JournalWriteQueue, cause: unknown): never {
  queue.poison(cause)
  throw new JournalCommittedWriteError(cause)
}

export function notifyJournalCommitted(listener?: () => void): void {
  try {
    assertJournalSynchronousResult(listener?.())
  } catch (error) {
    console.warn('[agent-session-journal] durable commit observer failed', error)
  }
}
