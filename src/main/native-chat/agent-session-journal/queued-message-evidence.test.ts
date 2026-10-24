import { releaseJournalEpochPins } from './journal-epoch-pins'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  pinQueuedMessageEvidence,
  readPinnedQueuedMessageEvidence,
  readQueuedMessageEvidence
} from './queued-message-origin'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'

const roots: string[] = []
const journals = createTrackedJournalOpener()
afterEach(async () => {
  await journals.closeAll()
  closeTestJournalHostDatabases()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-queue-evidence-'))
  roots.push(root)
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: 'session',
      workspaceId: 'folder',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    },
    now: () => 100,
    mintEpoch: (() => {
      let n = 0
      return () => `epoch-${++n}`
    })()
  })
  const host = openTestJournalHostDatabase(root)
  return { journal, host }
}

it('captures exact edited body and options without changing original admission time', async () => {
  const { journal, host } = await fixture()
  const original = await journal.queuedMessages.insert({
    messageId: 'draft',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'original' }] },
    options: { model: 'chosen' }
  })
  await journal.queuedMessages.update({
    messageId: 'draft',
    expectedBodyFingerprint: original.fingerprint,
    text: 'edited'
  })
  const card = journal.queuedMessages.get('draft')!
  const proof = readQueuedMessageEvidence(host.db, {
    sourceSessionId: 'session',
    messageId: 'draft',
    fingerprint: card.fingerprint
  })
  expect(proof).toMatchObject({
    sourceSessionId: 'session',
    admittedAt: 100,
    body: card.body,
    options: original.options
  })
  expect(
    readQueuedMessageEvidence(host.db, {
      sourceSessionId: 'session',
      messageId: 'draft',
      fingerprint: original.fingerprint
    })?.body
  ).toEqual(original.body)
  expect(host.db.prepare('SELECT 1 FROM queued_messages').get()).toBeUndefined()
})

it('rolls origin and evidence back with a failing insertion receipt, then retries once', async () => {
  const { journal, host } = await fixture()
  const input = {
    messageId: 'draft',
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'draft' }]
    }
  }
  await expect(
    journal.queuedMessages.insert(input, {
      write: () => {
        throw new Error('failed receipt')
      },
      committed: () => {}
    })
  ).rejects.toThrow('failed receipt')
  expect(journal.queuedMessages.get('draft')).toBeNull()
  expect(host.db.prepare('SELECT 1 FROM queued_message_origins').get()).toBeUndefined()
  expect(host.db.prepare('SELECT 1 FROM queued_message_evidence').get()).toBeUndefined()
  const card = await journal.queuedMessages.insert(input)
  expect(
    readQueuedMessageEvidence(host.db, {
      sourceSessionId: 'session',
      messageId: 'draft',
      fingerprint: card.fingerprint
    })
  ).not.toBeNull()
})

it.each(['rollover', 'replacement'])(
  'keeps exact pinned edited original across %s and replay',
  async (mode) => {
    const { journal, host } = await fixture()
    const original = await journal.queuedMessages.insert({
      messageId: 'draft',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'birth' }] },
      options: { model: 'model-a' }
    })
    await journal.queuedMessages.update({
      messageId: 'draft',
      expectedBodyFingerprint: original.fingerprint,
      text: 'selected edited original'
    })
    const edited = journal.queuedMessages.get('draft')!
    const input = {
      ownerId: 'transfer',
      sourceSessionId: 'session',
      messageId: 'draft',
      fingerprint: edited.fingerprint
    }
    const pinned = host.transaction((db) => pinQueuedMessageEvidence(db, input))
    expect(host.transaction((db) => pinQueuedMessageEvidence(db, input))).toEqual(pinned)
    expect(() =>
      host.db
        .prepare(
          'INSERT OR REPLACE INTO queued_message_evidence_owners SELECT owner_id,session_id,message_id,fingerprint,source_epoch,source_sequence,? FROM queued_message_evidence_owners WHERE owner_id=?'
        )
        .run('{"position":999,"queuedAt":null}', input.ownerId)
    ).toThrow('owner already exists')
    expect(readPinnedQueuedMessageEvidence(host.db, input)).toEqual(pinned)
    await (mode === 'rollover'
      ? journal.rollEpoch('session_created', 1)
      : journal.replaceEpochItems('legacy_import', 1, []))
    expect(journal.queuedMessages.get('draft')).toMatchObject({
      body: edited.body,
      options: edited.options
    })
    expect(readPinnedQueuedMessageEvidence(host.db, input)).toEqual(pinned)
    expect(readQueuedMessageEvidence(host.db, input)?.source?.epoch).not.toBe(pinned.source?.epoch)
    await journal.close()
    const replay = await journals.open({
      stateDirectory: host.stateDirectory,
      identity: {
        sessionId: 'session',
        workspaceId: 'folder',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread')
      }
    })
    expect(replay.queuedMessages.get('draft')).toMatchObject({
      body: edited.body,
      options: edited.options
    })
    expect(readPinnedQueuedMessageEvidence(host.db, input)?.admittedAt).toBe(100)
    host.transaction((db) => releaseJournalEpochPins(db, input.ownerId))
    expect(readPinnedQueuedMessageEvidence(host.db, input)).toBeNull()
    expect(
      readQueuedMessageEvidence(host.db, { ...input, fingerprint: original.fingerprint })
    ).toBeNull()
    expect(readQueuedMessageEvidence(host.db, input)?.body).toEqual(edited.body)
    expect(
      host.db
        .prepare('SELECT 1 FROM queued_message_evidence_sources WHERE session_id=? AND epoch=?')
        .get('session', pinned.source!.epoch)
    ).toBeUndefined()
  }
)

it('rolls back a required evidence failure without publishing the inserted card', async () => {
  const { journal, host } = await fixture()
  host.db.exec(
    "CREATE TRIGGER fail_queue_evidence BEFORE INSERT ON queued_message_evidence_sources BEGIN SELECT RAISE(ABORT,'evidence failed'); END"
  )
  const input = {
    messageId: 'draft',
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'draft' }]
    }
  }
  const before = journal.cursor()
  await expect(journal.queuedMessages.insert(input)).rejects.toThrow('evidence failed')
  expect(journal.cursor()).toEqual(before)
  expect(journal.queuedMessages.get('draft')).toBeNull()
  expect(host.db.prepare('SELECT 1 FROM queued_message_origins').get()).toBeUndefined()
  host.db.exec('DROP TRIGGER fail_queue_evidence')
  await journal.queuedMessages.insert(input)
  expect(journal.queuedMessages.evidence('draft')?.admittedAt).toBe(100)
})

it('fences a rolled-back epoch with asynchronous invalidation without claiming it committed', async () => {
  const { journal } = await fixture()
  const before = journal.cursor()
  await expect(
    journal.replaceEpochItems('legacy_import', 1, [], () => ({
      write() {
        throw new Error('failed replacement')
      },
      committed() {},
      rolledBack: async () => {}
    }))
  ).rejects.toThrow('failed replacement')
  expect(journal.cursor()).toEqual(before)
  await expect(
    journal.queuedMessages.insert({
      messageId: 'after',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'must wait for replay' }]
      }
    })
  ).rejects.toThrow('requires durable replay')
})
