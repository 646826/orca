import { ConversationScratchClient } from './conversation-scratch-client'
import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../agent-session-journal/journal-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { buildConversationPresentationPages } from './conversation-presentation-pages'

let db: Database.Database
let root: string
const pin = { ownerId: 'source', sessionId: 'a', epoch: 'e', endSequence: 4 }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-context-pages-'))
  db = openJournalDatabase(join(root, 'journal.db')).db
  const base = (seq: number) => ({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'e',
    seq,
    ts: seq,
    fence: 1
  })
  insertJournalRow(db, 'a', {
    ...base(1),
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread' }
  })
  for (const [seq, revision, text] of [
    [2, 1, 'old'],
    [3, 2, 'new🙂'],
    [4, 1, 'distinct']
  ] as const) {
    insertJournalRow(db, 'a', {
      ...base(seq),
      kind: 'item',
      itemId: seq === 4 ? 'other' : 'message',
      revision,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
    })
  }
  runJournalTransaction(db, () => pinJournalEpoch(db, pin))
})
afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  rmSync(root, { recursive: true, force: true })
})
it('uses the existing reducer for revised and distinct items without exposing state', async () => {
  const result = await buildConversationPresentationPages({
    db,
    pin,
    scratchDirectory: root,
    maxCanonicalBytes: 1_000_000,
    signal: new AbortController().signal
  })
  if (result.kind !== 'built') {
    throw new Error(result.reason)
  }
  expect((await result.lease.itemPage(null, 128)).items.map((item) => item.revision)).toEqual([
    2, 1
  ])
  expect('state' in result.lease).toBe(false)
  expect('originalPage' in result.lease).toBe(false)
  await expect(result.lease.itemPage(null, 257)).rejects.toThrow()
  await result.lease.close()
  expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
  expect(db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
})
it('refuses byte overflow and cancellation without leaving temporary files', async () => {
  const input = {
    db,
    pin,
    scratchDirectory: root,
    maxCanonicalBytes: 1,
    signal: new AbortController().signal
  }
  expect(await buildConversationPresentationPages(input)).toMatchObject({
    kind: 'refused',
    reason: 'resource-limit'
  })
  const controller = new AbortController()
  controller.abort()
  expect(
    await buildConversationPresentationPages({
      ...input,
      maxCanonicalBytes: 100000,
      signal: controller.signal
    })
  ).toMatchObject({ kind: 'refused', reason: 'cancelled' })
  expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
})
it('cleans the private pin and scratch after cancellation at a bounded batch yield', async () => {
  for (let seq = 5; seq <= 132; seq++) {
    insertJournalRow(db, 'a', {
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'e',
      seq,
      ts: seq,
      fence: 1,
      kind: 'item',
      itemId: `item-${seq}`,
      revision: 1,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'small fixture' }]
      }
    })
  }
  const complete = { ...pin, ownerId: 'complete', endSequence: 132 }
  runJournalTransaction(db, () => pinJournalEpoch(db, complete))
  const abort = new AbortController()
  setImmediate(() => abort.abort())
  expect(
    await buildConversationPresentationPages({
      db,
      pin: complete,
      scratchDirectory: root,
      maxCanonicalBytes: 1_000_000,
      signal: abort.signal
    })
  ).toMatchObject({ kind: 'refused', reason: 'cancelled' })
  expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
  expect(
    db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(0)
})
it('cleans private replay resources when frozen rows cannot be parsed', async () => {
  db.prepare('INSERT INTO journal_rows (session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)').run(
    'a',
    'bad',
    1,
    1,
    'invalid json'
  )
  const damaged = { ...pin, ownerId: 'damaged', epoch: 'bad', endSequence: 1 }
  runJournalTransaction(db, () => pinJournalEpoch(db, damaged))
  expect(
    await buildConversationPresentationPages({
      db,
      pin: damaged,
      scratchDirectory: root,
      maxCanonicalBytes: 1000,
      signal: new AbortController().signal
    })
  ).toMatchObject({ kind: 'refused', reason: 'invalid-provenance' })
  expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
  expect(
    db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(0)
})
it('retains its pin when temporary cleanup fails and resumes cleanup without closing the database twice', async () => {
  await scratchWorker.fault('remove-once')
  const result = await buildConversationPresentationPages({
    db,
    pin,
    scratchDirectory: root,
    maxCanonicalBytes: 1_000_000,
    signal: new AbortController().signal
  })
  if (result.kind !== 'built') {
    throw new Error('expected page lease')
  }
  await expect(result.lease.close()).rejects.toThrow('temporary removal failed')
  expect(scratchWorker.trace()).toContainEqual({ kind: 'fault', operation: 'remove' })
  expect(
    db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(1)
  await expect(result.lease.itemPage(null, 1)).rejects.toThrow()
  const exec = db.exec.bind(db)
  let releaseObserved = false
  vi.spyOn(db, 'exec').mockImplementation((sql) => {
    exec(sql)
    if (
      sql === 'COMMIT' &&
      db
        .prepare(
          "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
        )
        .get()?.count === 0
    ) {
      releaseObserved = true
      expect(scratchWorker.trace().some((event) => event.kind === 'removed')).toBe(true)
      expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual(
        []
      )
    }
  })
  await expect(result.lease.close()).resolves.toBeUndefined()
  expect(releaseObserved).toBe(true)
  expect(
    db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(0)
})

it('preserves newer-schema refusal for a retained future row', async () => {
  db.prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)').run(
    'future',
    'future',
    1,
    1,
    JSON.stringify({
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1,
      epoch: 'future',
      seq: 1,
      ts: 1,
      kind: 'epoch'
    })
  )
  const future = { ownerId: 'future', sessionId: 'future', epoch: 'future', endSequence: 1 }
  runJournalTransaction(db, () => pinJournalEpoch(db, future))
  expect(
    await buildConversationPresentationPages({
      db,
      pin: future,
      scratchDirectory: root,
      maxCanonicalBytes: 1_000_000,
      signal: new AbortController().signal
    })
  ).toEqual({ kind: 'refused', reason: 'newer-schema' })
})

it('does not treat a missing epoch prefix as valid presentation and releases private resources', async () => {
  insertJournalRow(db, 'missing', {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'missing',
    seq: 1,
    ts: 1,
    fence: 1,
    kind: 'item',
    itemId: 'message',
    revision: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'no epoch' }] }
  })
  const result = await buildConversationPresentationPages({
    db,
    pin: { ownerId: 'missing', sessionId: 'missing', epoch: 'missing', endSequence: 1 },
    scratchDirectory: root,
    maxCanonicalBytes: 10000,
    signal: new AbortController().signal
  })
  expect(result).toMatchObject({ kind: 'refused', reason: 'invalid-provenance' })
  expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
  expect(
    db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(0)
})

const scratchWorker = installScratchWorkerFixture()

it('keeps cancellation pending and its source pin held until asynchronous scratch cleanup is proved', async () => {
  const abort = new AbortController()
  const cleanupEntered = Promise.withResolvers<void>()
  const allowCleanup = Promise.withResolvers<void>()
  const openReplay = ConversationScratchClient.prototype.openReplay
  const close = ConversationScratchClient.prototype.close
  vi.spyOn(ConversationScratchClient.prototype, 'openReplay').mockImplementationOnce(
    async function (this: ConversationScratchClient, ...args: Parameters<typeof openReplay>) {
      await openReplay.apply(this, args)
      abort.abort()
    }
  )
  vi.spyOn(ConversationScratchClient.prototype, 'close').mockImplementationOnce(async function (
    this: ConversationScratchClient
  ) {
    cleanupEntered.resolve()
    await allowCleanup.promise
    await close.call(this)
  })
  let settled = false
  const pending = buildConversationPresentationPages({
    db,
    pin,
    scratchDirectory: root,
    maxCanonicalBytes: 1_000_000,
    signal: abort.signal
  })
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await cleanupEntered.promise
  try {
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
        )
        .get()?.count
    ).toBe(1)
    expect(
      readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))
    ).toHaveLength(1)
  } finally {
    allowCleanup.resolve()
    await pending.catch(() => {})
  }
  await expect(pending).resolves.toEqual({ kind: 'refused', reason: 'cancelled' })
  expect(
    db
      .prepare(
        "SELECT COUNT(*) count FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
      )
      .get()?.count
  ).toBe(0)
  expect(readdirSync(root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
})
