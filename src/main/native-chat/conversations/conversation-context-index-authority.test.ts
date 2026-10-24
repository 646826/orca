import {
  contextSourceArchive,
  contextSourceRow,
  contextSourceText
} from './conversation-context-source-row.fixture'
import { serializeJournalRow, type JournalRow } from '../agent-session-journal/journal-row-schema'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { conversationEvidenceKey } from './conversation-context-policy'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationContextDigest } from './conversation-context-consent'
import {
  conversationContextAccountDigest,
  conversationContextSourceRevision
} from './conversation-context-authority'
import {
  authorizeConversationManifestIndex,
  assertConversationManifestIndexAuthorization
} from './conversation-context-index-authority'
import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
let db: Database.Database, root: string
const location = {
  executionHostId: 'local' as const,
  wslDistro: null,
  workspaceId: 'folder',
  workspaceKind: 'folder' as const
}
const identity = {
  provider: 'codex',
  accountHome: { variable: 'AGENT_HOME', path: '/account' },
  location
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-index-authority-'))
  db = openJournalDatabase(join(root, 'db')).db
  db.prepare('INSERT INTO conversations VALUES(?,?)').run(
    'c',
    JSON.stringify({
      conversationId: 'c',
      location,
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'segment',
      pendingOperationKey: null
    })
  )
  for (const sessionId of ['a', 'b']) {
    db.prepare('INSERT INTO conversation_participants VALUES(?,?,?)').run(
      sessionId,
      'c',
      JSON.stringify({
        ...identity,
        sessionId,
        conversationId: 'c',
        nativeBindingGeneration: 1,
        contextGeneration: 1,
        state: sessionId === 'a' ? 'active' : 'parked'
      })
    )
  }
  db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
    'segment',
    'c',
    1,
    JSON.stringify({
      segmentId: 'segment',
      conversationId: 'c',
      ordinal: 1,
      sessionId: 'a',
      contextGeneration: 1,
      activationFence: 1,
      nativeBindingGeneration: 1,
      startSequence: 1,
      boundary: { sessionId: 'a', epoch: 'e', endSequence: 1 }
    })
  )
  db.prepare('INSERT INTO conversation_source_attribution VALUES(?,?,?,?)').run(
    'a',
    'e',
    1,
    'segment'
  )
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('fixture', 'a', 'e', 1)
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})
async function fixture(
  policy: 'budgeted' | 'full' = 'budgeted',
  row: JournalRow = contextSourceRow()
) {
  const sourceText = serializeJournalRow(row)
  const archive = contextSourceArchive('a', [row])
  db.prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)').run(
    'a',
    row.epoch,
    row.seq,
    row.ts,
    sourceText
  )
  const version = {
    source: { sessionId: 'a', epoch: 'e', sequence: 1 },
    sha256: createHash('sha256').update(sourceText).digest('hex')
  }
  const part = {
    version,
    representation: policy === 'full' ? ('exact' as const) : ('retrievable-only' as const),
    ...(policy === 'full' ? { text: sourceText } : {}),
    artifactId: 'archive',
    spans: []
  }
  const sourceRevision = conversationContextSourceRevision(db, 'c', 'b')
  const result = await compileConversationContextPages({
    db,
    expected: {
      sourceCount: 1,
      orderedVersionDigest: createHash('sha256')
        .update(conversationEvidenceKey(version))
        .update('\n')
        .digest('hex')
    },
    maxInlineBytes: 10000,
    resolveRequirement: async (sourceVersion) => ({
      version: sourceVersion,
      contextGeneration: 1,
      sourceRevision,
      requirement: 'projection-approved'
    }),
    rows: (async function* () {
      yield {
        original: {
          version,
          byteLength: Buffer.byteLength(sourceText),
          ...(policy === 'full' ? { text: sourceText } : {}),
          artifactId: 'archive',
          kind: 'historical-data' as const,
          gaps: []
        },
        representation: part
      }
    })(),
    conversationId: 'c',
    contextGeneration: 1,
    sourceRevision,
    target: {
      sessionId: 'b',
      provider: 'codex',
      accountBindingDigest: conversationContextAccountDigest(identity),
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'model',
      retrieval: 'verified'
    },
    policy,
    mandatory: [],
    budget:
      policy === 'full'
        ? {
            capacity: 10000,
            occupied: 0,
            reserved: 1000,
            confidence: 'upper-bound',
            targetFingerprint: 'caps',
            nativeBindingGeneration: 1,
            model: 'model',
            accountBindingDigest: conversationContextAccountDigest(identity),
            observedAt: 1,
            validUntil: 2
          }
        : null,
    // Synthetic byte-unit capacity, not a provider token estimate.
    countTokens: (text) => Buffer.byteLength(text),
    inputTokenConfidence: 'exact',
    signal: new AbortController().signal,
    now: 1
  })
  if (result.kind !== 'compiled') {
    throw new Error(result.reason)
  }
  const manifest = result.manifest
  db.prepare('INSERT INTO conversation_source_versions VALUES(?,?,?,?,?,?,?)').run(
    'a',
    'e',
    1,
    version.sha256,
    Buffer.byteLength(sourceText),
    row.kind,
    row.kind === 'lifecycle-batch' ? row.mutations.length : 0
  )
  db.prepare('INSERT INTO conversation_attachment_claims VALUES(?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'archive.jsonl',
    archive.sha256,
    archive.byteLength,
    1
  )
  db.prepare('INSERT INTO conversation_export_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'archive.jsonl',
    'c',
    1,
    'a',
    'e',
    1,
    version.sha256,
    archive.sources[0]!.frameOffset,
    archive.sources[0]!.byteOffset,
    archive.sources[0]!.byteLength
  )
  db.prepare('INSERT INTO conversation_export_disclosures VALUES(?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'archive.jsonl',
    'c',
    1,
    manifest.targetBindingDigest,
    JSON.stringify(['a', 'e', 1, null, null, null]),
    version.sha256,
    JSON.stringify({
      version,
      contextGeneration: 1,
      targetBindingDigest: manifest.targetBindingDigest,
      action: 'include',
      reason: 'user-policy',
      critical: false
    })
  )
  return manifest
}
function proof(m: ConversationContextManifest, sourceText = contextSourceText) {
  return () => ({
    proofId: 'fixture',
    manifestDigest: m.digest,
    targetBindingDigest: m.targetBindingDigest,
    capabilityFingerprint: m.target.capabilityFingerprint,
    contextGeneration: m.contextGeneration,
    sourceRevision: m.sourceRevision,
    budgetDigest: conversationContextDigest(m.budget),
    evidenceIndex: m.evidenceIndex,
    sourceEnumeration: {
      sourceCount: 1,
      orderedVersionDigest: createHash('sha256')
        .update(
          conversationEvidenceKey({
            source: { sessionId: 'a', epoch: 'e', sequence: 1 },
            sha256: createHash('sha256').update(sourceText).digest('hex')
          })
        )
        .update('\n')
        .digest('hex')
    }
  })
}
it('requires validated indexed source authority and invalidates it after claim loss', async () => {
  const m = await fixture()
  expect(() => assertConversationManifestIndexAuthorization(db, m)).toThrow()
  await authorizeConversationManifestIndex(db, m, proof(m), new AbortController().signal)
  expect(() => assertConversationManifestIndexAuthorization(db, m)).not.toThrow()
  db.prepare('DELETE FROM conversation_attachment_claims').run()
  expect(() => assertConversationManifestIndexAuthorization(db, m)).toThrow()
})
it('refuses an authority mutation while asynchronous validation is in flight', async () => {
  const m = await fixture()
  const pending = authorizeConversationManifestIndex(db, m, proof(m), new AbortController().signal)
  db.prepare('DELETE FROM conversation_attachment_claims').run()
  await expect(pending).rejects.toThrow()
  expect(() => assertConversationManifestIndexAuthorization(db, m)).toThrow()
})
it('invalidates indexed authority when canonical version or original segment authority changes', async () => {
  const manifest = await fixture()
  await authorizeConversationManifestIndex(
    db,
    manifest,
    proof(manifest),
    new AbortController().signal
  )
  db.prepare('DELETE FROM conversation_source_versions').run()
  expect(() => assertConversationManifestIndexAuthorization(db, manifest)).toThrow()
})
it('invalidates indexed authority when the original source segment generation changes', async () => {
  const manifest = await fixture()
  await authorizeConversationManifestIndex(
    db,
    manifest,
    proof(manifest),
    new AbortController().signal
  )
  db.prepare(
    "UPDATE conversation_segments SET record_json=json_set(record_json,'$.contextGeneration',2)"
  ).run()
  expect(() => assertConversationManifestIndexAuthorization(db, manifest)).toThrow()
})
it('refuses a compilation whose enumeration differs from the independently supplied host source set', async () => {
  const manifest = await fixture()
  const expected = proof(manifest)()
  await expect(
    authorizeConversationManifestIndex(
      db,
      manifest,
      () => ({
        ...expected,
        sourceEnumeration: { sourceCount: 2, orderedVersionDigest: 'b'.repeat(64) }
      }),
      new AbortController().signal
    )
  ).rejects.toThrow('enumeration')
})
it('accepts complete same-generation batch atom authority without inventing a single row origin', async () => {
  const item = contextSourceRow()
  const mutation = {
    kind: item.kind,
    itemId: item.itemId,
    revision: item.revision,
    body: item.body
  }
  const batch: JournalRow = {
    kind: 'lifecycle-batch',
    v: item.v,
    epoch: item.epoch,
    seq: item.seq,
    fence: item.fence,
    ts: item.ts,
    settlementId: 'settled',
    mutations: [mutation, { ...mutation, itemId: 'returned-message' }]
  }
  const sourceText = serializeJournalRow(batch)
  const manifest = await fixture('budgeted', batch)
  const hash = createHash('sha256').update(sourceText).digest('hex')
  db.prepare('DELETE FROM conversation_source_attribution').run()
  const old = db
    .prepare('SELECT record_json FROM conversation_segments WHERE segment_id=?')
    .get('segment')
  if (typeof old?.record_json !== 'string') {
    throw new Error('Missing fixture segment')
  }
  db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
    'return',
    'c',
    2,
    JSON.stringify({ ...JSON.parse(old.record_json), segmentId: 'return', ordinal: 2 })
  )
  for (const [path, segmentId] of [
    ['$', 'segment'],
    ['$.mutations[0]', 'segment'],
    ['$.mutations[1]', 'return']
  ]) {
    db.prepare('INSERT INTO conversation_source_atoms VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      'a',
      'e',
      1,
      path,
      segmentId,
      1,
      1,
      hash,
      2,
      null,
      null
    )
  }
  await authorizeConversationManifestIndex(
    db,
    manifest,
    proof(manifest, sourceText),
    new AbortController().signal
  )
  expect(() => assertConversationManifestIndexAuthorization(db, manifest)).not.toThrow()
  db.prepare(
    "UPDATE conversation_segments SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE segment_id='return'"
  ).run()
  await expect(
    authorizeConversationManifestIndex(
      db,
      manifest,
      proof(manifest, sourceText),
      new AbortController().signal
    )
  ).rejects.toThrow()
})
it('refuses indexed authority after its protecting epoch pin disappears', async () => {
  const manifest = await fixture()
  await authorizeConversationManifestIndex(
    db,
    manifest,
    proof(manifest),
    new AbortController().signal
  )
  const retained = db
    .prepare(
      'SELECT retention_owner FROM conversation_manifest_index_authorizations WHERE manifest_id=?'
    )
    .get(manifest.manifestId)
  if (typeof retained?.retention_owner !== 'string') {
    throw new Error('Missing retained owner')
  }
  db.prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?').run(retained.retention_owner)
  expect(() => assertConversationManifestIndexAuthorization(db, manifest)).toThrow()
})

it('authorizes full indexed evidence only when every canonical part is exact and inline', async () => {
  const manifest = await fixture('full')
  expect(manifest.projection).toHaveLength(1)
  expect(manifest.projection[0]).toMatchObject({ representation: 'exact', text: contextSourceText })
  await authorizeConversationManifestIndex(
    db,
    manifest,
    proof(manifest),
    new AbortController().signal
  )
  expect(() => assertConversationManifestIndexAuthorization(db, manifest)).not.toThrow()
  const omitted = { ...manifest, projection: [] }
  await expect(
    authorizeConversationManifestIndex(db, omitted, proof(omitted), new AbortController().signal)
  ).rejects.toThrow()
  const unknown = { ...manifest, budget: null }
  await expect(
    authorizeConversationManifestIndex(db, unknown, proof(unknown), new AbortController().signal)
  ).rejects.toThrow()
})
