import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import {
  authorizeConversationSourceAtoms,
  prepareConversationSourceAtomReceipt,
  recordConversationSourceVersion
} from './conversation-source-atoms'
import type { ConversationSegment } from '../../../shared/conversation-record'
let root: string
let host: JournalHostDatabase
const source = { sessionId: 'session-a', epoch: 'epoch-a', sequence: 1 }
const pin = { ownerId: 'prepared-atoms', sessionId: 'session-a', epoch: 'epoch-a', endSequence: 1 }
const origin = (segmentId = 'segment-1', contextGeneration = 1) => ({
  conversationId: 'conversation',
  segmentId,
  sessionId: 'session-a',
  contextGeneration,
  nativeBindingGeneration: 1
})
function authorization() {
  const row = host.db.prepare('SELECT row_json FROM journal_rows').get()
  if (typeof row?.row_json !== 'string') {
    throw new Error('missing row')
  }
  return {
    conversationId: 'conversation',
    contextGeneration: 1,
    source,
    sha256: createHash('sha256').update(row.row_json).digest('hex'),
    mutationCount: 2
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-source-atoms-'))
  host = JournalHostDatabase.open(root)
  host.db.prepare('INSERT INTO conversations VALUES(?,?)').run(
    'conversation',
    JSON.stringify({
      conversationId: 'conversation',
      location: {
        executionHostId: 'local',
        workspaceId: 'folder',
        workspaceKind: 'folder',
        wslDistro: null
      },
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'segment-1',
      pendingOperationKey: null
    })
  )
  for (const [segmentId, contextGeneration, ordinal] of [
    ['segment-1', 1, 1],
    ['segment-2', 1, 2],
    ['archived', 2, 3]
  ] as const) {
    const segment: ConversationSegment = {
      segmentId,
      conversationId: 'conversation',
      sessionId: 'session-a',
      contextGeneration,
      ordinal,
      activationFence: ordinal,
      nativeBindingGeneration: 1,
      startSequence: 1,
      boundary: { sessionId: 'session-a', epoch: 'epoch-a', endSequence: 1 }
    }
    host.db
      .prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)')
      .run(segmentId, 'conversation', ordinal, JSON.stringify(segment))
  }
  host.transaction((db) => {
    insertJournalRow(db, 'session-a', {
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: 'epoch-a',
      seq: 1,
      fence: 1,
      ts: 1,
      kind: 'lifecycle-batch',
      settlementId: 'mixed',
      mutations: [
        {
          kind: 'item',
          itemId: 'first',
          revision: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }
        },
        { kind: 'tombstone', itemId: 'second', revision: 2 }
      ]
    })
    pinJournalEpoch(db, pin)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  host.close()
  rmSync(root, { recursive: true, force: true })
})
it('requires explicit envelope and every sibling origin before whole batch disclosure', () => {
  expect(authorizeConversationSourceAtoms(host.db, authorization())).toBe(false)
  const receipt = prepareConversationSourceAtomReceipt(host.db, {
    pin,
    source,
    envelopeOrigin: origin(),
    mutationOrigins: [
      { batchIndex: 0, origin: origin() },
      { batchIndex: 1, origin: origin('segment-2') }
    ]
  })
  host.transaction((db) => receipt.write(db))
  expect(authorizeConversationSourceAtoms(host.db, authorization())).toBe(true)
  expect(
    host.db.prepare('SELECT row_kind,mutation_count FROM conversation_source_versions').get()
  ).toEqual({ row_kind: 'lifecycle-batch', mutation_count: 2 })
  expect(authorizeConversationSourceAtoms(host.db, { ...authorization(), mutationCount: 1 })).toBe(
    false
  )
})
it('refuses archived-generation sibling, changed hash and forged atom index', () => {
  const receipt = prepareConversationSourceAtomReceipt(host.db, {
    pin,
    source,
    envelopeOrigin: origin(),
    mutationOrigins: [
      { batchIndex: 0, origin: origin() },
      { batchIndex: 1, origin: origin('archived', 2) }
    ]
  })
  host.transaction((db) => receipt.write(db))
  expect(authorizeConversationSourceAtoms(host.db, authorization())).toBe(false)
  expect(
    authorizeConversationSourceAtoms(host.db, { ...authorization(), sha256: '0'.repeat(64) })
  ).toBe(false)
  expect(() =>
    prepareConversationSourceAtomReceipt(host.db, {
      pin,
      source,
      envelopeOrigin: origin(),
      mutationOrigins: [{ batchIndex: 2, origin: origin() }]
    })
  ).toThrow()
})
it('requires the preparation pin at commit and refuses conflicting canonical versions', () => {
  const receipt = prepareConversationSourceAtomReceipt(host.db, {
    pin,
    source,
    envelopeOrigin: origin(),
    mutationOrigins: []
  })
  host.db.prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?').run(pin.ownerId)
  expect(() => host.transaction((db) => receipt.write(db))).toThrow()
  host.transaction((db) => pinJournalEpoch(db, pin))
  host.transaction((db) => receipt.write(db))
  expect(() =>
    host.transaction((db) =>
      recordConversationSourceVersion(db, {
        pin,
        source,
        sha256: '0'.repeat(64),
        byteLength: 1,
        kind: 'lifecycle-batch',
        mutationCount: 2
      })
    )
  ).toThrow()
})
it('does not parse or reread source payload inside commit and rolls back forged origin metadata', () => {
  const receipt = prepareConversationSourceAtomReceipt(host.db, {
    pin,
    source,
    envelopeOrigin: origin(),
    mutationOrigins: [{ batchIndex: 0, origin: { ...origin(), nativeBindingGeneration: 2 } }]
  })
  const prepare = vi.spyOn(host.db, 'prepare')
  expect(() => host.transaction((db) => receipt.write(db))).toThrow('identity-mismatch')
  expect(prepare.mock.calls.some(([sql]) => sql.includes('row_json'))).toBe(false)
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_source_versions').get()?.n).toBe(0)
  expect(host.db.prepare('SELECT COUNT(*) n FROM conversation_source_atoms').get()?.n).toBe(0)
})
it('preserves newer journal schema refusal instead of reporting corruption', () => {
  host.db.exec('DELETE FROM journal_epoch_pins')
  host.db.prepare("UPDATE journal_rows SET row_json=json_set(row_json,'$.v',999)").run()
  host.transaction((db) => pinJournalEpoch(db, pin))
  expect(() =>
    prepareConversationSourceAtomReceipt(host.db, {
      pin,
      source,
      envelopeOrigin: origin(),
      mutationOrigins: []
    })
  ).toThrow(expect.objectContaining({ code: 'journal_read_only' }))
})
