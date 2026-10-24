import { BroadcastChannel } from 'node:worker_threads'
import { setImmediate } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { buildConversationPresentationPages } from './conversation-presentation-pages'
import { ConversationScratchClient } from './conversation-scratch-client'
import { buildScratchWorkerFixture } from './conversation-scratch-worker.test-fixture'
import {
  tearDownRuntime,
  type InstalledRuntime
} from '../../runtime/structured-agent-session-runtime-teardown'

function runtime(database: JournalHostDatabase): InstalledRuntime {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown uses only these host methods; no provider was started.
    host: { stopDelivery() {}, async flushAllStreamedEvents() {} } as InstalledRuntime['host'],
    adapter: { async closeAll() {} },
    journalDatabase: database,
    async waitForRecovery() {}
  }
}
async function fixture(fault: 'replay-block' | 'remove-once') {
  const root = mkdtempSync(join(tmpdir(), 'orca-scratch-blocked-'))
  const worker = await buildScratchWorkerFixture({ directory: root, fault })
  const host = JournalHostDatabase.open(root)
  host.transaction((db) =>
    insertJournalRow(db, 's', {
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      seq: 1,
      ts: 1,
      fence: 1,
      epoch: 'e',
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 't' }
    })
  )
  const client = new ConversationScratchClient(root, { workerPath: worker.workerPath })
  await client.ready
  return {
    root,
    host,
    client,
    worker,
    build: (signal = new AbortController().signal) =>
      buildConversationPresentationPages({
        db: host.db,
        pin: { ownerId: 'test', sessionId: 's', epoch: 'e', endSequence: 1 },
        scratchDirectory: root,
        maxCanonicalBytes: 10000,
        signal,
        scratch: client
      })
  }
}
function blocked(channelName: string) {
  const channel = new BroadcastChannel(channelName)
  const waiting = Promise.withResolvers<{ buffer: SharedArrayBuffer; transactionOpen: boolean }>()
  channel.onmessage = (event) => {
    const value: unknown = event.data
    if (
      typeof value === 'object' &&
      value !== null &&
      'buffer' in value &&
      value.buffer instanceof SharedArrayBuffer &&
      'transactionOpen' in value &&
      typeof value.transactionOpen === 'boolean'
    ) {
      waiting.resolve({ buffer: value.buffer, transactionOpen: value.transactionOpen })
    }
  }
  return { channel, waiting: waiting.promise }
}
function release(buffer: SharedArrayBuffer): void {
  const view = new Int32Array(buffer)
  Atomics.store(view, 0, 1)
  Atomics.notify(view, 0)
}
it('keeps main-loop cancellation responsive while a real scratch COMMIT is blocked, but waits for cleanup', async () => {
  const f = await fixture('replay-block')
  const gate = blocked(`${f.worker.workerPath}.control`)
  const abort = new AbortController()
  const build = f.build(abort.signal)
  let settled = false
  void build
    .finally(() => {
      settled = true
    })
    .catch(() => {})
  const held = await gate.waiting
  try {
    expect(held.transactionOpen).toBe(true)
    abort.abort()
    await setImmediate()
    await setImmediate()
    expect(settled).toBe(false)
    expect(f.host.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
  } finally {
    release(held.buffer)
    gate.channel.close()
  }
  try {
    await expect(build).resolves.toEqual({ kind: 'refused', reason: 'cancelled' })
    expect(f.host.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(0)
  } finally {
    await f.client.close()
    f.host.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})
it('runtime teardown stops admission and keeps its source owner open until blocked worker cleanup releases the pin', async () => {
  const f = await fixture('replay-block')
  const gate = blocked(`${f.worker.workerPath}.control`)
  const build = f.build()
  void build.catch(() => {})
  const held = await gate.waiting
  const teardown = tearDownRuntime(runtime(f.host), 'quit')
  let stopped = false
  void teardown.then(() => {
    stopped = true
  })
  try {
    await setImmediate()
    expect(stopped).toBe(false)
    expect(f.host.isClosed).toBe(false)
    expect(f.host.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
    expect(() => new ConversationScratchClient(f.root)).toThrow('stopping')
  } finally {
    release(held.buffer)
    gate.channel.close()
  }
  try {
    await expect(build).rejects.toThrow()
    await teardown
    expect(f.host.isClosed).toBe(true)
    expect(() => ConversationScratchClient.reopenAdmission(f.root)).not.toThrow()
  } finally {
    await f.client.close()
    f.host.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})
it('failed runtime cleanup retains the source owner and blocks replacement until retried teardown succeeds', async () => {
  const f = await fixture('remove-once')
  const result = await f.build()
  expect(result.kind).toBe('built')
  try {
    await expect(tearDownRuntime(runtime(f.host), 'quit')).rejects.toThrow('cleanup is incomplete')
    expect(f.host.isClosed).toBe(false)
    expect(f.host.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
    expect(() => ConversationScratchClient.reopenAdmission(f.root)).toThrow('cleanup is incomplete')
    await tearDownRuntime(runtime(f.host), 'quit')
    expect(f.host.isClosed).toBe(true)
    expect(() => ConversationScratchClient.reopenAdmission(f.root)).not.toThrow()
  } finally {
    await f.client.close()
    f.host.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})
