import { expect, it } from 'vitest'
import { db } from './conversation-context-coverage.fixture'
import {
  assertConversationAuthorityRevision,
  readConversationAuthorityRevision,
  assertConversationCoverageRevision,
  readConversationCoverageRevision
} from './conversation-context-authority-revision'

it('invalidates source authority when a native correlation is persisted or resolved', () => {
  const before = readConversationAuthorityRevision(db)
  db.prepare('INSERT INTO conversation_origin_correlations VALUES(?,?,?,?,?,?)').run(
    'session-a',
    1,
    'submission',
    'turn',
    null,
    0
  )
  expect(() => assertConversationAuthorityRevision(db, before)).toThrow('Context authority changed')
  const pending = readConversationAuthorityRevision(db)
  db.prepare('UPDATE conversation_origin_correlations SET resolved=1').run()
  expect(() => assertConversationAuthorityRevision(db, pending)).toThrow(
    'Context authority changed'
  )
})

it.each([
  ['conversation_origin_acquisitions', ['session-a', 1, '{}', null]],
  ['conversation_origin_enrollments', ['session-a', 'e', 1, '{}']],
  ['conversation_origin_bindings', ['session-a', 1, 'submission', 'send', '{}']],
  ['conversation_origin_rows', ['session-a', 'e', 1, '$', '[]', null, 'conv', 1, 1]]
] as const)('invalidates prepared delivery authority when %s evidence changes', (table, values) => {
  const before = readConversationAuthorityRevision(db)
  db.prepare(`INSERT INTO ${table} VALUES(${values.map(() => '?').join(',')})`).run(...values)
  expect(() => assertConversationAuthorityRevision(db, before)).toThrow('Context authority changed')
  const inserted = readConversationAuthorityRevision(db)
  db.prepare(`UPDATE ${table} SET origin_json=?`).run('{"changed":true}')
  expect(() => assertConversationAuthorityRevision(db, inserted)).toThrow(
    'Context authority changed'
  )
  const updated = readConversationAuthorityRevision(db)
  db.prepare(`DELETE FROM ${table}`).run()
  expect(() => assertConversationAuthorityRevision(db, updated)).toThrow(
    'Context authority changed'
  )
})

it.each([
  [
    'conversation_context_coverage',
    ['session-b', 'binding', 1, 1, 'source', 'representation', 'manifest', '{}']
  ],
  ['conversation_context_index_receipts', ['manifest', 'receipt', 'index', 'digest', 1]]
] as const)(
  'invalidates prepared assignments when prior %s coverage is added or deleted',
  (table, values) => {
    db.prepare('INSERT INTO conversation_context_manifests VALUES(?,?,?,?)').run(
      'manifest',
      '{}',
      null,
      '{}'
    )
    db.prepare('INSERT INTO conversation_manifest_part_indexes VALUES(?,?,?,?,?,?)').run(
      'index',
      'conv',
      1,
      'source',
      1,
      'digest'
    )
    const sourceRevision = readConversationAuthorityRevision(db)
    const before = readConversationCoverageRevision(db)
    db.prepare(`INSERT INTO ${table} VALUES(${values.map(() => '?').join(',')})`).run(...values)
    expect(() => assertConversationCoverageRevision(db, before)).toThrow('Context coverage changed')
    const inserted = readConversationCoverageRevision(db)
    db.prepare(`DELETE FROM ${table}`).run()
    expect(() => assertConversationCoverageRevision(db, inserted)).toThrow(
      'Context coverage changed'
    )
    expect(readConversationAuthorityRevision(db)).toBe(sourceRevision)
  }
)
