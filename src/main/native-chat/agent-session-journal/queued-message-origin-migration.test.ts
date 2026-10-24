import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  preserveLegacyQueuedMessageEvidence,
  readQueuedMessageEvidence
} from './queued-message-origin'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'

it('migrates known/null origins and reserved legacy source before importer deletion without disabling FKs', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-queue-origin-migration-'))
  const path = join(root, 'journal.db')
  let db = openJournalDatabase(path).db
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'edited legacy original' }]
  }
  const fingerprint = agentSessionSendBodyFingerprint('session', body)
  const known = JSON.stringify({
    birthDigest: 'birth',
    boundaryDigest: 'boundary',
    conversationId: 'c',
    contextGeneration: 1
  })
  try {
    // Deliberate old-feature schema fixture: the importer, not SQL mutation, owns its deletion.
    db.exec(`DROP TABLE queued_message_origins;
      CREATE TABLE queued_message_origins(session_id TEXT NOT NULL,message_id TEXT NOT NULL,origin_json TEXT,
        PRIMARY KEY(session_id,message_id),FOREIGN KEY(session_id,message_id) REFERENCES queued_messages(session_id,message_id) ON DELETE CASCADE);
      DROP TABLE conversation_transfer_no_write;
      DROP TABLE conversation_transfer_recoveries;
      DROP TABLE conversation_trigger_reservations;
      CREATE TABLE conversation_trigger_reservations (
        transfer_id TEXT PRIMARY KEY,kind TEXT NOT NULL,operation_key TEXT NOT NULL REFERENCES conversation_switch_intents(operation_key),
        queue_session_id TEXT NOT NULL,message_id TEXT NOT NULL,target_session_id TEXT NOT NULL,target_submission_id TEXT NOT NULL,
        binding_json TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(target_session_id,target_submission_id),
        FOREIGN KEY(queue_session_id,message_id) REFERENCES queued_messages(session_id,message_id));
      PRAGMA user_version=12;`)
    db.prepare('INSERT INTO conversations VALUES(?,?)').run('c', '{}')
    db.prepare('INSERT INTO conversation_switch_intents VALUES(?,?,?)').run('operation', 'c', '{}')
    for (const messageId of ['known', 'unknown']) {
      db.prepare(`INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,options_json)
        VALUES(?,?,?,?,?,17,'legacy','waiting',?)`).run(
        'session',
        messageId,
        1,
        JSON.stringify(body),
        fingerprint,
        '{"model":"legacy-model"}'
      )
      db.prepare('INSERT INTO queued_message_origins VALUES(?,?,?)').run(
        'session',
        messageId,
        messageId === 'known' ? known : null
      )
    }
    db.prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(
      'transfer',
      'trigger',
      'operation',
      'session',
      'known',
      'target',
      'submission',
      JSON.stringify({ sourceFingerprint: fingerprint }),
      'reserved'
    )
    db.close()
    db = openJournalDatabase(path).db
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('user_version', { simple: true })).toBe(13)
    expect(db.prepare('PRAGMA foreign_key_list(queued_message_origins)').all()).toEqual([])
    expect(
      db
        .prepare('PRAGMA foreign_key_list(conversation_trigger_reservations)')
        .all()
        .some((key) => key.table === 'queued_messages')
    ).toBe(false)
    runJournalTransaction(db, () => {
      for (const messageId of ['known', 'unknown']) {
        preserveLegacyQueuedMessageEvidence(db, 'session', messageId)
        db.prepare('DELETE FROM queued_messages WHERE session_id=? AND message_id=?').run(
          'session',
          messageId
        )
      }
    })
    expect(
      db.prepare('SELECT origin_json FROM queued_message_origins WHERE message_id=?').get('known')
        ?.origin_json
    ).toBe(known)
    expect(
      db.prepare('SELECT origin_json FROM queued_message_origins WHERE message_id=?').get('unknown')
        ?.origin_json
    ).toBeNull()
    expect(db.prepare('SELECT state FROM conversation_trigger_reservations').get()?.state).toBe(
      'reserved'
    )
    expect(
      readQueuedMessageEvidence(db, { sourceSessionId: 'session', messageId: 'known', fingerprint })
    ).toMatchObject({ body, admittedAt: 17, options: { model: 'legacy-model' } })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
