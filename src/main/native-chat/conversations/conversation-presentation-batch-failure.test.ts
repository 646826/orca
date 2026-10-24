import { installScratchWorkerFixture } from './conversation-scratch-worker-setup.test-fixture'
import { readdirSync } from 'node:fs'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { runJournalTransaction } from '../agent-session-journal/journal-transaction'
import { releaseJournalEpochPins } from '../agent-session-journal/journal-epoch-pins'
import { presentationFixture as fixture } from './conversation-presentation-batching.fixture'

it.each(['source', 'scratch'] as const)(
  'rolls back a failed %s COMMIT and discards the unpublished projection',
  async (failure) => {
    const f = fixture(Array.from({ length: 64 }, () => 'canonical row'))
    let failed = false
    const exec = Database.prototype.exec
    const fault =
      failure === 'source'
        ? vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
            this: Database.Database,
            sql
          ) {
            const proofs = f.db
              .prepare('SELECT COUNT(*) count FROM conversation_source_versions')
              .get()
            if (sql === 'COMMIT' && this === f.db && !failed && proofs?.count === 32) {
              failed = true
              throw new Error('failed-source-commit')
            }
            exec.call(this, sql)
          })
        : undefined
    if (failure === 'scratch') {
      await scratchWorker.fault('replay-commit')
    }
    await expect(f.build()).rejects.toThrow(`failed-${failure}-commit`)
    if (failure === 'source') {
      expect(failed).toBe(true)
    } else {
      expect(scratchWorker.trace()).toContainEqual({ kind: 'fault', operation: 'commit' })
    }
    expect(f.db.isTransaction).toBe(false)
    expect(
      f.db.prepare('SELECT COUNT(*) count FROM conversation_source_versions').get()?.count
    ).toBe(16)
    expect(
      f.db.prepare('SELECT COUNT(*) count FROM conversation_context_coverage').get()?.count
    ).toBe(0)
    expect(f.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
    expect(readdirSync(f.root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual(
      []
    )
    fault?.mockRestore()
    scratchWorker.reset()
    const rebuilt = await f.build()
    if (rebuilt.kind !== 'built') {
      throw new Error(rebuilt.reason)
    }
    expect((await rebuilt.lease.itemPage(null, 128)).items).toHaveLength(64)
    await rebuilt.lease.close()
  }
)

it('refuses publication when the private pin is revoked in the final committed-batch yield', async () => {
  const f = fixture(['last item'])
  const exec = Database.prototype.exec
  let revoke: Promise<void> | undefined
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
    exec.call(this, sql)
    if (this !== f.db || sql !== 'COMMIT' || revoke) {
      return
    }
    const count = f.db
      .prepare('SELECT COUNT(*) count FROM conversation_source_versions')
      .get()?.count
    if (count === f.pin.endSequence) {
      revoke = yieldLoop().then(() => {
        const owner = f.db
          .prepare(
            "SELECT owner_id FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-presentation:%'"
          )
          .get()?.owner_id
        expect(typeof owner).toBe('string')
        runJournalTransaction(f.db, () => releaseJournalEpochPins(f.db, String(owner)))
      })
    }
  })
  const result = f.build()
  // Close a wrongly published lease too, so the RED control leaves no private scratch behind.
  void result.then(
    async (value) => {
      if (value.kind === 'built') {
        await value.lease.close()
      }
    },
    () => {}
  )
  await expect(result).rejects.toThrow('missing-source')
  await revoke
  expect(f.db.prepare('SELECT COUNT(*) count FROM conversation_source_versions').get()?.count).toBe(
    2
  )
  expect(f.db.prepare('SELECT COUNT(*) count FROM journal_epoch_pins').get()?.count).toBe(1)
  expect(readdirSync(f.root).filter((name) => name.startsWith('conversation-scratch-'))).toEqual([])
})

const scratchWorker = installScratchWorkerFixture()
