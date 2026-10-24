import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  pinQueuedMessageEvidence,
  preserveLegacyQueuedMessageEvidence,
  readPinnedQueuedMessageEvidence,
  readQueuedMessageEvidence
} from './queued-message-origin'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
const roots: string[] = []
const journals = createTrackedJournalOpener()
afterEach(async () => {
  await journals.closeAll()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.restoreAllMocks()
})
const body = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'exact edited legacy draft' }]
}
const fingerprint = agentSessionSendBodyFingerprint('session-import', body)
async function fixture(state: 'waiting' | 'withdrawn' = 'waiting') {
  const root = mkdtempSync(join(tmpdir(), 'orca-evidence-import-'))
  roots.push(root)
  const host = openTestJournalHostDatabase(root)
  const open = () =>
    journals.open({
      stateDirectory: root,
      identity: {
        sessionId: 'session-import',
        workspaceId: 'folder',
        hostId: 'host',
        agent: 'codex',
        providerHandle: codexProviderHandle('native')
      },
      now: () => 100
    })
  const initial = await open()
  await initial.close()
  for (const id of ['known', 'unknown']) {
    // Deliberate released-queue fixture; all live actions below use the journal API.
    host.db
      .prepare(`INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,options_json,queued_epoch,queued_sequence)
      VALUES('session-import',?,?,?, ?,23,'old-host',?,'{"model":"legacy"}','original-epoch',9)`)
      .run(id, id === 'known' ? 1 : 2, JSON.stringify(body), fingerprint, state)
    host.db
      .prepare(
        'INSERT INTO queued_message_origins(session_id,message_id,origin_json,admitted_at) VALUES(?,?,?,?)'
      )
      .run(
        'session-import',
        id,
        id === 'known'
          ? JSON.stringify({
              birthDigest: 'birth',
              boundaryDigest: 'boundary',
              conversationId: 'conversation',
              contextGeneration: 1
            })
          : null,
        23
      )
  }
  host.db.prepare('INSERT INTO conversations VALUES(?,?)').run('conversation', '{}')
  host.db
    .prepare('INSERT INTO conversation_switch_intents VALUES(?,?,?)')
    .run('operation', 'conversation', '{}')
  host.db
    .prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'transfer',
      'trigger',
      'operation',
      'session-import',
      'known',
      'target',
      'submission',
      JSON.stringify({ sourceFingerprint: fingerprint }),
      'reserved'
    )
  return { host, open }
}
it.each([
  { kind: 'null', transferId: null },
  { kind: 'empty text', transferId: '' },
  { kind: 'blob', transferId: Buffer.from('transfer') }
])(
  'refuses a $kind legacy reservation ID without retaining evidence or owners',
  async ({ transferId }) => {
    const { host } = await fixture()
    // SQLite's non-STRICT TEXT PRIMARY KEY permits these values without altering the schema.
    host.db.prepare('UPDATE conversation_trigger_reservations SET transfer_id=?').run(transferId)
    host.db.prepare('DELETE FROM queued_message_origins WHERE message_id=?').run('known')
    expect(() =>
      host.transaction((db) => {
        preserveLegacyQueuedMessageEvidence(db, 'session-import', 'known', {
          ownerId: 'direct-pin',
          expectedFingerprint: fingerprint
        })
        db.prepare('DELETE FROM queued_messages WHERE message_id=?').run('known')
      })
    ).toThrow('invalid legacy reservation transfer id')
    expect(host.db.isTransaction).toBe(false)
    expect(host.db.prepare('SELECT 1 FROM queued_message_evidence').get()).toBeUndefined()
    expect(host.db.prepare('SELECT 1 FROM queued_message_evidence_owners').get()).toBeUndefined()
    expect(
      host.db.prepare('SELECT 1 FROM queued_message_origins WHERE message_id=?').get('known')
    ).toBeUndefined()
    expect(
      host.db.prepare('SELECT body_json FROM queued_messages WHERE message_id=?').get('known')
    ).toEqual({ body_json: JSON.stringify(body) })
    expect(host.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
)
it('preserves a nonempty legacy reservation ID exactly when retiring its queue row', async () => {
  const { host } = await fixture()
  host.db.prepare('UPDATE conversation_trigger_reservations SET transfer_id=?').run('0')
  host.transaction((db) => {
    preserveLegacyQueuedMessageEvidence(db, 'session-import', 'known')
    db.prepare('DELETE FROM queued_messages WHERE message_id=?').run('known')
  })
  expect(host.db.prepare('SELECT owner_id FROM queued_message_evidence_owners').all()).toEqual([
    { owner_id: 'conversation-transfer:0' }
  ])
  expect(
    readPinnedQueuedMessageEvidence(host.db, {
      ownerId: 'conversation-transfer:0',
      sourceSessionId: 'session-import',
      messageId: 'known',
      fingerprint
    })
  ).toMatchObject({
    body,
    admittedAt: 23,
    options: { model: 'legacy' },
    queueOrder: { position: 1, queuedAt: { epoch: 'original-epoch', sequence: 9 } }
  })
  expect(
    host.db.prepare('SELECT 1 FROM queued_messages WHERE message_id=?').get('known')
  ).toBeUndefined()
})
it('rolls failed import back, preserves pending exact original, and retries through the real importer', async () => {
  const { host, open } = await fixture()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  host.db.exec(
    "CREATE TRIGGER fail_import BEFORE INSERT ON queued_message_evidence_sources BEGIN SELECT RAISE(ABORT,'import failure'); END"
  )
  const failed = await open()
  expect(warning).toHaveBeenCalled()
  expect(failed.queuedMessages.get('known')?.body).toEqual(body)
  expect(host.db.prepare('SELECT count(*) n FROM queued_messages').get()?.n).toBe(2)
  expect(host.db.prepare('SELECT 1 FROM queued_message_evidence').get()).toBeUndefined()
  // Reservation may retain a readable legacy original even before import is retried.
  const pin = {
    ownerId: 'conversation-transfer:transfer',
    sourceSessionId: 'session-import',
    messageId: 'known',
    fingerprint
  }
  host.transaction((db) => pinQueuedMessageEvidence(db, pin))
  expect(readPinnedQueuedMessageEvidence(host.db, pin)).toMatchObject({
    body,
    admittedAt: 23,
    options: { model: 'legacy' },
    queueOrder: { position: 1, queuedAt: { epoch: 'original-epoch', sequence: 9 } }
  })
  await failed.close()
  host.db.exec('DROP TRIGGER fail_import')
  const replay = await open()
  expect(replay.queuedMessages.get('known')?.body).toEqual(body)
  expect(host.db.prepare('SELECT 1 FROM queued_messages').get()).toBeUndefined()
  expect(readPinnedQueuedMessageEvidence(host.db, pin)?.body).toEqual(body)
  expect(
    readQueuedMessageEvidence(host.db, {
      sourceSessionId: 'session-import',
      messageId: 'unknown',
      fingerprint
    })?.origin
  ).toBeNull()
  expect(host.db.prepare('SELECT state FROM conversation_trigger_reservations').get()?.state).toBe(
    'reserved'
  )
})
it('delete-only import retains reserved original without inventing a live queue card', async () => {
  const { host, open } = await fixture('withdrawn')
  const journal = await open()
  expect(journal.queuedMessages.list()).toEqual([])
  expect(host.db.prepare('SELECT 1 FROM queued_messages').get()).toBeUndefined()
  expect(
    host.db
      .prepare("SELECT 1 FROM journal_rows WHERE json_extract(row_json,'$.kind')='queue'")
      .get()
  ).toBeUndefined()
  expect(
    readPinnedQueuedMessageEvidence(host.db, {
      ownerId: 'conversation-transfer:transfer',
      sourceSessionId: 'session-import',
      messageId: 'known',
      fingerprint
    })
  ).toMatchObject({ body, admittedAt: 23, source: null })
  expect(
    readQueuedMessageEvidence(host.db, {
      sourceSessionId: 'session-import',
      messageId: 'unknown',
      fingerprint
    })
  ).toBeNull()
  expect(
    host.db
      .prepare('SELECT origin_json FROM queued_message_origins WHERE message_id=?')
      .get('unknown')?.origin_json
  ).toBeNull()
})
