// One chat's write queue: build, commit and adopt run one at a time, in arrival order.
//
// Closing is admission only. A closed store refuses new writes forever, so a stale reference
// (an event sink, a late callback) can never append from a fold a newer open has replaced; the
// writes already admitted still land, and `drain` resolves once they have.

import { AgentSessionJournalError } from './journal-write-guards'

/** What a write body returns: never a promise, since an await inside one would let a later write
 *  land first. */
export type JournalWriteResult<T> = T extends PromiseLike<unknown> ? never : T
export type JournalWriteBody<T> = () => JournalWriteResult<T>

/**
 * A write has landed in the fold when its call returns, unless it was issued from inside another
 * write or behind one still waiting in line.
 *
 * A write finds the queue idle unless a write is running or writes wait in line; then it runs
 * before `serialize` returns. Every write body is synchronous (`JournalWriteBody` refuses a
 * promise), so it has committed by then. Otherwise it joins the line behind the writes ahead of
 * it, never nested inside the running one. Admission is checked at ENQUEUE and is permanent.
 */
export class JournalWriteQueue {
  /** Settles once every write admitted so far has, whatever its outcome. */
  private writes: Promise<unknown> = Promise.resolve()
  /** Writes that joined the line and have not settled. */
  private waiting = 0
  private running = false
  private closed = false
  private recoveryError: AgentSessionJournalError | null = null

  constructor(private readonly sessionId: string) {}

  markClosed(): void {
    this.closed = true
  }

  /** Unlike closing admission, a failed durable adoption also fences work already in line. */
  poison(cause: unknown): void {
    this.closed = true
    this.recoveryError ??= new AgentSessionJournalError(
      'journal_closed',
      `agent-session journal for ${this.sessionId} requires durable replay`,
      { cause }
    )
  }

  /** One FIFO position in every lane, installed before any callback can admit another ticket. */
  static serializeTogether<T>(
    queues: readonly JournalWriteQueue[],
    run: JournalWriteBody<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (queues.length === 0 || new Set(queues).size !== queues.length) {
      return Promise.reject(new Error('compound journal lanes must be nonempty and distinct'))
    }
    for (const queue of queues) {
      if (queue.closed) {
        return Promise.reject(queue.recoveryError ?? queue.closedError())
      }
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }
    const idle = queues.every((queue) => !queue.lineBusy)
    const predecessors = queues.map((queue) => queue.writes)
    let resolve: (value: T | PromiseLike<T>) => void = () => undefined
    let reject: (error: unknown) => void = () => undefined
    const result = new Promise<T>((accepted, refused) => {
      resolve = accepted
      reject = refused
    })
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    for (const queue of queues) {
      queue.waiting++
      queue.writes = settled
    }
    const execute = (): void => {
      for (const queue of queues) {
        queue.waiting--
        queue.running = true
      }
      try {
        for (const queue of queues) {
          queue.assertReplayNotRequired()
        }
        signal?.throwIfAborted()
        const value = run()
        assertJournalSynchronousResult(value)
        resolve(value)
      } catch (error) {
        reject(error)
      } finally {
        for (const queue of queues) {
          queue.running = false
        }
      }
    }
    if (idle) {
      execute()
    } else {
      void Promise.all(predecessors).then(execute)
    }
    return result
  }

  serialize<T>(run: JournalWriteBody<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.recoveryError ?? this.closedError())
    }
    return this.lineBusy ? this.join(run) : this.runNow(run)
  }

  /** Runs `read` after every write admitted before it, whatever each one's outcome, and ahead of any
   *  admitted after: at once when none waits. A closed queue refuses it, as it refuses a write: its
   *  fold may be replaced. */
  readInOrder<T>(read: () => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.recoveryError ?? this.closedError())
    }
    return this.lineBusy ? this.join(read) : this.runNow(read)
  }

  private get lineBusy(): boolean {
    return this.running || this.waiting > 0
  }

  private closedError(): AgentSessionJournalError {
    return new AgentSessionJournalError(
      'journal_closed',
      `agent-session journal for ${this.sessionId} is closed`
    )
  }

  private assertReplayNotRequired(): void {
    if (this.recoveryError) {
      throw this.recoveryError
    }
  }

  /** Resolves once every write admitted so far has settled, whatever its outcome. */
  drain(): Promise<void> {
    return this.writes.then(() => undefined)
  }

  /** Runs before returning; a write issued from inside it joins the line behind it. */
  private runNow<T>(run: () => T): Promise<T> {
    let release: (settled: Promise<unknown>) => void = () => undefined
    this.writes = new Promise<unknown>((resolve) => {
      release = resolve
    })
    this.running = true
    let result: Promise<T>
    try {
      this.assertReplayNotRequired()
      result = Promise.resolve(run())
    } catch (error) {
      result = Promise.reject(error)
    } finally {
      this.running = false
    }
    release(result.catch(() => undefined))
    return result
  }

  private join<T>(run: () => T): Promise<T> {
    const started = this.writes.then(() => {
      this.assertReplayNotRequired()
      return run()
    })
    this.writes = started.catch(() => undefined)
    this.waiting++
    const settle = (): void => {
      this.waiting--
    }
    started.then(settle, settle)
    return started
  }
}

export function assertJournalSynchronousResult(value: unknown): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    throw new Error('an owned journal write must not await')
  }
}
