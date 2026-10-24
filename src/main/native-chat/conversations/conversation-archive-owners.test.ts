import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from '../agent-session-journal/journal-host-database-test-support'
import { CONVERSATION_ARCHIVE_OWNERS } from './conversation-archive-owners'

it('enumerates no-write proof owners only through their exact transfer conversation and generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-archive-owners-'))
  try {
    const host = openTestJournalHostDatabase(root)
    host.transaction((db) => {
      // Storage-only ownership fixture; these records confer no send or recovery authority.
      for (const conversationId of ['selected', 'unrelated']) {
        db.prepare('INSERT INTO conversations VALUES(?,?)').run(conversationId, '{}')
        db.prepare('INSERT INTO conversation_switch_intents VALUES(?,?,?)').run(
          conversationId,
          conversationId,
          '{}'
        )
      }
      for (const [id, conversationId, generation] of [
        ['one', 'selected', 1],
        ['two', 'selected', 2],
        ['three', 'unrelated', 1]
      ] as const) {
        db.prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(
          id,
          'queued-continuation',
          conversationId,
          'source',
          id,
          'target',
          id,
          JSON.stringify({ conversationId, contextGeneration: generation }),
          'cancelled'
        )
        for (const attempt of [0, 1]) {
          db.prepare('INSERT INTO conversation_transfer_no_write VALUES(?,?,?,?,?,?,?)').run(
            id,
            attempt,
            'target',
            id,
            'retired',
            attempt + 1,
            '{}'
          )
        }
      }
    })
    const owners = host.db
      .prepare(CONVERSATION_ARCHIVE_OWNERS)
      .all('selected', 1, '')
      .map((row) => row.owner_id)
    expect(owners).toEqual([
      'conversation-no-write:one:0',
      'conversation-no-write:one:1',
      'conversation-transfer:one'
    ])
    expect(
      host.db
        .prepare(CONVERSATION_ARCHIVE_OWNERS)
        .all('selected', 1, 'conversation-no-write:one:0')
        .map((row) => row.owner_id)
    ).toEqual(['conversation-no-write:one:1', 'conversation-transfer:one'])
  } finally {
    closeTestJournalHostDatabases()
    rmSync(root, { recursive: true, force: true })
  }
})
