import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from '../agent-session-journal/journal-database-schema'
import { readSwitchIntent } from './conversation-read-model'

it('preserves legacy frozen intent evidence while marking candidate origin unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-candidate-migration-'))
  const file = join(root, 'journal.db')
  let db = openJournalDatabase(file).db
  try {
    db.prepare('INSERT INTO conversations VALUES(?,?)').run('c', '{}')
    const legacy = {
      operationKey: 'op',
      conversationId: 'c',
      targetSessionId: 'b',
      contextGeneration: 1,
      activationFence: 2,
      nativeBindingGeneration: 1,
      version: 3,
      phase: 'reconciliation-required',
      sourceBoundaries: [{ sessionId: 'a', epoch: 'a', endSequence: 1 }],
      candidateBaseline: [],
      candidateBoundary: { sessionId: 'b', epoch: 'b', endSequence: 1 },
      manifestId: 'frozen',
      deliveryReceiptId: null
    }
    db.prepare('INSERT INTO conversation_switch_intents VALUES(?,?,?)').run(
      'op',
      'c',
      JSON.stringify(legacy)
    )
    db.pragma('user_version=7')
    db.close()
    db = openJournalDatabase(file).db
    expect(db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
    expect(readSwitchIntent(db, 'op')).toEqual({ ...legacy, candidateSegmentId: null })
    expect(db.prepare('SELECT COUNT(*) n FROM conversation_segments').get()?.n).toBe(0)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
