import { ConversationScratchClient } from './conversation-scratch-client'
import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { releaseJournalEpochPins } from '../agent-session-journal/journal-epoch-pins'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  presentationFixture as fixture,
  presentationTransactions as transactions
} from './conversation-presentation-batching.fixture'

it('commits bounded replay batches rather than a durable transaction per row', async () => {
  const f = fixture(Array.from({ length: 64 }, (_, index) => `message ${index}`))
  const observed = transactions(f.db)
  const result = await f.build()
  if (result.kind !== 'built') {
    throw new Error(result.reason)
  }
  try {
    expect((await result.lease.itemPage(null, 128)).items).toHaveLength(64)
    expect(observed.batches.map((batch) => batch.count)).toEqual([16, 16, 16, 16, 1])
    expect(scratchWorker.trace().filter((event) => event.kind === 'commit')).toHaveLength(5)
    expect(
      scratchWorker
        .trace()
        .filter((event) => event.kind === 'appendReplay')
        .map((event) => event.count)
    ).toEqual([16, 16, 16, 16, 1])
    expect(
      scratchWorker
        .trace()
        .filter((event) => event.kind === 'commit')
        .every((event) => event.idle)
    ).toBe(true)
    expect(f.db.pragma('synchronous', { simple: true })).toBe(2)
    expect(f.db.isTransaction).toBe(false)
  } finally {
    await result.lease.close()
  }
  expect(readdirSync(f.root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
})
it('bounds encoded batch bytes while preserving a larger valid Unicode row alone', async () => {
  const large = '🙂'.repeat(100000)
  const f = fixture(['small', large, 'after large', large])
  const observed = transactions(f.db)
  const result = await f.build()
  if (result.kind !== 'built') {
    throw new Error(result.reason)
  }
  try {
    expect(observed.batches.map((batch) => batch.count)).toEqual([2, 1, 1, 1])
    expect(observed.batches.filter((batch) => batch.bytes > 256 * 1024)).toHaveLength(2)
    expect(observed.batches.every((batch) => batch.bytes <= 256 * 1024 || batch.count === 1)).toBe(
      true
    )
    expect((await result.lease.itemPage(null, 128, 2 * 1024 * 1024)).items).toHaveLength(4)
  } finally {
    await result.lease.close()
  }
})

it.each(['source', 'scratch'] as const)(
  'discards unpublished replay after a %s batch failure and rebuilds from exact sources',
  async (failure) => {
    const f = fixture(Array.from({ length: 64 }, (_, index) => `message ${index}`))
    const originals = f.db.prepare('SELECT seq,row_json FROM journal_rows ORDER BY seq').all()
    let restore = () => {}
    if (failure === 'source') {
      f.db.exec(`CREATE TRIGGER fail_source_batch BEFORE INSERT ON conversation_source_versions
        WHEN NEW.sequence=20 BEGIN SELECT RAISE(ABORT,'batch-source-failed'); END;`)
      restore = () => f.db.exec('DROP TRIGGER fail_source_batch')
    } else {
      await scratchWorker.fault('replay-item')
      restore = () => scratchWorker.reset()
    }
    await expect(f.build()).rejects.toThrow(`batch-${failure}-failed`)
    if (failure === 'scratch') {
      expect(scratchWorker.trace()).toContainEqual({ kind: 'fault', operation: 'item' })
    }
    expect(f.db.isTransaction).toBe(false)
    expect(
      f.db.prepare('SELECT COUNT(*) count FROM conversation_source_versions').get()?.count
    ).toBe(16)
    expect(f.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
    expect(readdirSync(f.root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual(
      []
    )
    expect(f.db.prepare('SELECT seq,row_json FROM journal_rows ORDER BY seq').all()).toEqual(
      originals
    )
    restore()
    const rebuilt = await f.build()
    if (rebuilt.kind !== 'built') {
      throw new Error(rebuilt.reason)
    }
    try {
      expect((await rebuilt.lease.itemPage(null, 128)).items).toHaveLength(64)
      const versions = f.db
        .prepare(`SELECT v.sha256,v.byte_length,r.row_json
        FROM conversation_source_versions v JOIN journal_rows r
        ON r.session_id=v.session_id AND r.epoch=v.epoch AND r.seq=v.sequence`)
        .all()
      expect(versions).toHaveLength(65)
      for (const row of versions) {
        expect(row.sha256).toBe(createHash('sha256').update(String(row.row_json)).digest('hex'))
        expect(row.byte_length).toBe(Buffer.byteLength(String(row.row_json)))
      }
      expect(
        f.db.prepare('SELECT COUNT(*) count FROM conversation_context_coverage').get()?.count
      ).toBe(0)
    } finally {
      await rebuilt.lease.close()
    }
  }
)

it.each(['cancel', 'revoke-pin'] as const)(
  'yields with both databases idle and cleans unpublished replay on %s',
  async (action) => {
    const f = fixture(
      action === 'cancel' ? ['🙂'.repeat(100000)] : Array.from({ length: 64 }, () => 'small row')
    )
    const observed = transactions(f.db)
    const abort = new AbortController()
    let idleAtYield = false,
      proofsAtYield: unknown
    const openReplay = ConversationScratchClient.prototype.openReplay
    vi.spyOn(ConversationScratchClient.prototype, 'openReplay').mockImplementationOnce(
      async function (this: ConversationScratchClient, ...args: Parameters<typeof openReplay>) {
        await openReplay.apply(this, args)
        idleAtYield =
          [...observed.connections].every((connection) => !connection.isTransaction) &&
          scratchWorker.trace().some((event) => event.kind === 'openReplay' && event.idle)
        proofsAtYield = f.db
          .prepare('SELECT COUNT(*) count FROM conversation_source_versions')
          .get()?.count
        if (action === 'cancel') {
          abort.abort()
        } else {
          const owner = f.db
            .prepare(
              "SELECT owner_id FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
            )
            .get()?.owner_id
          if (typeof owner !== 'string') {
            throw new Error('Presentation pin missing before interruption')
          }
          runJournalTransaction(f.db, () => releaseJournalEpochPins(f.db, owner))
        }
      }
    )
    await (action === 'cancel'
      ? expect(f.build(abort.signal)).resolves.toEqual({ kind: 'refused', reason: 'cancelled' })
      : expect(f.build()).rejects.toThrow('missing-source'))
    expect(idleAtYield).toBe(true)
    if (action === 'cancel') {
      expect(proofsAtYield).toBe(0)
    }
    expect(f.db.isTransaction).toBe(false)
    expect(
      f.db.prepare('SELECT COUNT(*) count FROM conversation_source_versions').get()?.count
    ).toBe(proofsAtYield)
    expect(f.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
    expect(readdirSync(f.root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual(
      []
    )
  }
)

it('keeps frozen source identity when another writer appends between batches', async () => {
  const f = fixture(Array.from({ length: 64 }, () => 'frozen row'))
  const append = yieldLoop().then(() =>
    runJournalTransaction(f.db, () =>
      insertJournalRow(f.db, 's', {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'e',
        seq: 66,
        ts: 66,
        fence: 1,
        kind: 'item',
        itemId: 'concurrent',
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'later' }] }
      })
    )
  )
  const result = await f.build()
  await append
  if (result.kind !== 'built') {
    throw new Error(result.reason)
  }
  try {
    const items = (await result.lease.itemPage(null, 128)).items
    expect(items).toHaveLength(64)
    expect(items.some((item) => item.itemId === 'concurrent')).toBe(false)
    expect(
      f.db.prepare('SELECT MAX(sequence) last FROM conversation_source_versions').get()?.last
    ).toBe(65)
    expect(f.db.prepare('SELECT MAX(seq) last FROM journal_rows').get()?.last).toBe(66)
  } finally {
    await result.lease.close()
  }
})

const scratchWorker = installScratchWorkerFixture()
