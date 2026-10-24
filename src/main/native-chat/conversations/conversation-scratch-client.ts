import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { OwnedWorkerThread } from '../../owned-worker-thread'
import type { JournalEpochPin } from '../agent-session-journal/journal-epoch-pins'
import type { ConversationItemPageCursor } from './conversation-reducer-disk-map'
import type { ConversationHistoryIndex } from './conversation-history-index'
import {
  ConversationReplayResourceLimit,
  DEFAULT_CONVERSATION_PAGE_BYTES
} from './conversation-replay-resource-limit'
import { resolveConversationScratchWorkerPath } from './conversation-scratch-worker-path'
import {
  ConversationScratchCommandSchema,
  ConversationScratchResponseSchema,
  CONVERSATION_SCRATCH_JOB_LIMIT,
  ScratchReplayPage,
  ScratchReplayFinished,
  ScratchHistoricalPage,
  assertScratchMessageBound,
  type ConversationScratchCommand,
  type ConversationScratchReplayEntry,
  type ConversationScratchHistoryEntry
} from './conversation-scratch-protocol'

type Pending = {
  id: number
  command: string
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
let admittedJobs = 0
const pendingCleanup = new Set<ConversationScratchClient>()
const activeClients = new Set<ConversationScratchClient>()
const stoppingRoots = new Set<string>()

/** One bounded in-flight command, with exit-proven private cleanup before releasing admission. */
export class ConversationScratchClient {
  readonly ready: Promise<void>
  private readonly directory: string
  private thread: OwnedWorkerThread | undefined
  private pending: Pending | undefined
  private nextId = 1
  private failure: Error | undefined
  private closing = false
  private closeAcknowledged = false
  private cleaned = false
  private closePromise: Promise<void> | undefined
  private readonly cleanupListeners = new Set<() => void>()

  constructor(
    private readonly root: string,
    options: { workerPath?: string } = {}
  ) {
    ConversationScratchClient.assertAdmission(root)
    if (admittedJobs >= CONVERSATION_SCRATCH_JOB_LIMIT) {
      throw new ConversationReplayResourceLimit(0)
    }
    admittedJobs++
    activeClients.add(this)
    this.directory = join(root, `conversation-scratch-${randomUUID()}`)
    const pending = this.createPending(0, 'initialize')
    this.pending = pending
    this.ready = pending.promise.then((value) => {
      z.null().parse(value)
    })
    void this.ready.catch(() => {})
    try {
      this.thread = new OwnedWorkerThread(
        options.workerPath ?? resolveConversationScratchWorkerPath(),
        { directory: this.directory },
        {
          message: (value) => this.receive(value),
          error: (error) => this.fault(error),
          exit: (code) => {
            if (!this.closeAcknowledged || code !== 0) {
              this.fault(new Error(`Conversation scratch worker exited (${code})`))
            }
          }
        }
      )
    } catch (error) {
      this.fault(error instanceof Error ? error : new Error(String(error)))
    }
  }
  async openReplay(pin: JournalEpochPin): Promise<void> {
    await this.empty({ command: 'open-replay', pin })
  }
  async appendReplay(entries: readonly ConversationScratchReplayEntry[]): Promise<void> {
    await this.empty({ command: 'append-replay', entries: [...entries] })
  }
  async finishReplay() {
    return ScratchReplayFinished.parse(await this.call({ command: 'finish-replay' }))
  }
  async replayPage(
    after: ConversationItemPageCursor | null,
    limit: number,
    maxBytes = DEFAULT_CONVERSATION_PAGE_BYTES
  ) {
    return ScratchReplayPage.parse(
      await this.call({ command: 'replay-page', after, limit, maxBytes })
    )
  }
  async closeReplay(): Promise<void> {
    if (this.cleaned) {
      return
    }
    if (this.failure || this.closing) {
      await this.close()
      return
    }
    await this.empty({ command: 'close-replay' })
  }
  onCleanup(run: () => void): () => void {
    if (this.closing) {
      throw new Error('Conversation scratch is closing')
    }
    this.cleanupListeners.add(run)
    return () => {
      this.cleanupListeners.delete(run)
    }
  }
  async openHistory(): Promise<void> {
    await this.empty({ command: 'open-history' })
  }
  async beginHistoryEpoch(): Promise<void> {
    await this.empty({ command: 'begin-history-epoch' })
  }
  async appendHistory(entries: readonly ConversationScratchHistoryEntry[]): Promise<void> {
    await this.empty({ command: 'append-history', entries: [...entries] })
  }
  async flushHistory(): Promise<void> {
    await this.empty({ command: 'flush-history' })
  }
  async historyPage(input: Parameters<ConversationHistoryIndex['page']>[0]) {
    return ScratchHistoricalPage.parse(await this.call({ command: 'history-page', input }))
  }
  static assertAdmission(root: string): void {
    if (stoppingRoots.has(root)) {
      throw new Error('Conversation scratch owner is stopping')
    }
  }
  static assertOwnerReleased(root: string): void {
    if ([...activeClients].some((client) => client.root === root)) {
      throw new Error('Conversation scratch owner cleanup is incomplete')
    }
  }
  static reopenAdmission(root: string): void {
    this.assertOwnerReleased(root)
    stoppingRoots.delete(root)
  }
  static async stopAndDrain(root: string): Promise<void> {
    stoppingRoots.add(root)
    const failures: unknown[] = []
    for (const client of activeClients) {
      if (client.root !== root) {
        continue
      }
      try {
        await client.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Conversation scratch cleanup is incomplete')
    }
  }
  static async retryPending(root: string): Promise<void> {
    for (const client of pendingCleanup) {
      if (client.root === root) {
        await client.close()
      }
    }
  }
  close(): Promise<void> {
    this.closing = true
    this.closePromise ??= this.finishClose().catch((error) => {
      this.closePromise = undefined
      pendingCleanup.add(this)
      throw error
    })
    return this.closePromise
  }
  private async finishClose(): Promise<void> {
    if (this.cleaned) {
      return
    }
    await this.pending?.promise.catch(() => {})
    if (!this.failure && !this.closeAcknowledged) {
      try {
        z.null().parse(await this.dispatch({ command: 'close' }))
      } catch (error) {
        if (!this.failure) {
          throw error
        }
      }
    }
    await this.thread?.exitPromise
    // A requested termination is not cleanup; only actual exit permits removing this private tree.
    await rm(this.directory, { recursive: true, force: true })
    for (const run of this.cleanupListeners) {
      run()
      this.cleanupListeners.delete(run)
    }
    this.cleaned = true
    pendingCleanup.delete(this)
    activeClients.delete(this)
    admittedJobs--
  }
  private async empty(command: ConversationScratchCommand): Promise<void> {
    z.null().parse(await this.call(command))
  }
  private async call(command: ConversationScratchCommand): Promise<unknown> {
    const result = await this.dispatch(command)
    if (this.closing) {
      throw new Error('Conversation scratch is closing')
    }
    return result
  }
  private dispatch(command: ConversationScratchCommand): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.cleaned || (this.closing && command.command !== 'close')) {
      return Promise.reject(new Error('Conversation scratch is closing'))
    }
    if (this.pending) {
      return Promise.reject(new Error('Conversation scratch command already in flight'))
    }
    try {
      ConversationScratchCommandSchema.parse(command)
      assertScratchMessageBound({ ...command, id: this.nextId })
    } catch (error) {
      return Promise.reject(
        error instanceof RangeError ? new ConversationReplayResourceLimit(0) : error
      )
    }
    const pending = this.createPending(this.nextId++, command.command)
    this.pending = pending
    try {
      this.thread?.post({ ...command, id: pending.id })
    } catch (error) {
      this.settle(undefined, error)
    }
    return pending.promise
  }
  private createPending(id: number, command: string): Pending {
    return { id, command, ...Promise.withResolvers<unknown>() }
  }
  private receive(value: unknown): void {
    if (this.failure) {
      return
    }
    const response = ConversationScratchResponseSchema.safeParse(value)
    const pending = this.pending
    if (!response.success || !pending || response.data.id !== pending.id) {
      this.fault(new Error('Invalid conversation scratch response'))
      return
    }
    try {
      assertScratchMessageBound(value)
    } catch {
      this.fault(new Error('Invalid conversation scratch response size'))
      return
    }
    if (!response.data.ok) {
      const error = response.data.resourceLimit
        ? new ConversationReplayResourceLimit(0)
        : new Error(response.data.message)
      this.settle(undefined, error)
      if (pending.command === 'initialize') {
        this.fault(error)
      }
      return
    }
    if (pending.command === 'close') {
      if (response.data.value !== null) {
        this.fault(new Error('Invalid conversation scratch close response'))
        return
      }
      this.closeAcknowledged = true
    }
    this.settle(response.data.value)
  }
  private settle(value?: unknown, error?: unknown): void {
    const pending = this.pending
    this.pending = undefined
    if (error !== undefined) {
      pending?.reject(error)
    } else {
      pending?.resolve(value)
    }
  }
  private fault(error: Error): void {
    this.failure ??= error
    this.settle(undefined, this.failure)
    this.thread?.terminate()
  }
}
