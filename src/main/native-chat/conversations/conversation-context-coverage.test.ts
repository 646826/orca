import {
  contextSourceArchive,
  contextSourceRow,
  contextSourceText
} from './conversation-context-source-row.fixture'
import { serializeJournalRow } from '../agent-session-journal/journal-row-schema'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { runJournalTransaction } from '../agent-session-journal/journal-database'
import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import {
  hasConversationRepresentationCoverage,
  planConversationIndexedDeltaPage
} from './conversation-context-index-delta'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import { authorizeConversationManifestIndex } from './conversation-context-index-authority'
import {
  consentForConversationManifest,
  conversationContextDigest
} from './conversation-context-consent'
import {
  saveConversationManifest,
  recordConversationCoverage,
  readConversationCoverage,
  planConversationDelta,
  readConversationManifest,
  readConversationIndexedCoveragePage
} from './conversation-context-coverage'
import type { ConversationContextRepresentation } from '../../../shared/conversation-handoff'
import {
  db,
  manifest,
  installDeliveryIntent,
  receipt,
  installArchiveProof,
  proofFor
} from './conversation-context-coverage.fixture'
it('persists immutable manifest and consent without manufacturing a delivery receipt', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
  )
  expect(readConversationManifest(db, m.manifestId)).toEqual(m)
  expect(readConversationCoverage(db, 'session-b', 1, 1)).toEqual([])
  expect(() =>
    runJournalTransaction(db, () =>
      recordConversationCoverage(db, m.manifestId, 'accepted', () => null)
    )
  ).toThrow('unverified')
  expect(() =>
    db.prepare('UPDATE conversation_context_manifests SET manifest_json = ?').run('{}')
  ).toThrow()
})
it('requires durable same-native proof rather than reusing a session id or a changed recipient binding', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () => {
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), proofFor(m))
  })
  const scope = { ...m, nativeIdentityDigest: 'fixture-native' }
  expect(hasConversationRepresentationCoverage(db, scope, m.projection[0])).toBe(true)
  for (const changed of [
    { ...scope, nativeIdentityDigest: undefined },
    { ...scope, nativeIdentityDigest: 'replacement-native' },
    { ...scope, targetBindingDigest: 'changed-recipient' },
    { ...scope, contextGeneration: 2 },
    { ...scope, target: { ...scope.target, sessionId: 'different-session' } },
    { ...scope, target: { ...scope.target, nativeBindingGeneration: 2 } }
  ]) {
    expect(hasConversationRepresentationCoverage(db, changed, m.projection[0])).toBe(false)
  }
})
it('commits representation-specific coverage only with verified native acceptance', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () => {
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), proofFor(m))
  })
  const coverage = readConversationCoverage(db, 'session-b', 1, 1)
  expect(coverage).toHaveLength(1)
  expect(coverage[0].representation).toBe('retrievable-only')
  expect(planConversationDelta(m, coverage, () => true)).toEqual([])
  expect(
    planConversationDelta(
      {
        ...m,
        projection: [{ ...m.projection[0], representation: 'exact', text: contextSourceText }]
      },
      coverage
    )
  ).toHaveLength(1)
  expect(readConversationCoverage(db, 'session-b', 2, 1)).toEqual([])
  expect(readConversationCoverage(db, 'session-b', 1, 2)).toEqual([])
})
it('keeps repeated identical content from different source rows distinct and rejects wrong binding', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
  )
  expect(() =>
    runJournalTransaction(db, () =>
      recordConversationCoverage(db, m.manifestId, 'accepted', () => ({
        ...receipt(m),
        nativeBindingGeneration: 2
      }))
    )
  ).toThrow('unverified')
  const part = m.projection[0]
  const changed = {
    ...part,
    version: { ...part.version, source: { ...part.version.source, sequence: 2 } }
  }
  expect(planConversationDelta({ ...m, projection: [part, changed] }, [])).toHaveLength(2)
})
it('fails closed without host capability proof and never accepts a phantom archive locator', () => {
  const m = manifest()
  expect(() =>
    runJournalTransaction(db, () =>
      saveConversationManifest(db, m, consentForConversationManifest(m, 'user'))
    )
  ).toThrow()
  const proof = () => ({
    manifestDigest: m.digest,
    proofId: 'test-only-capability',
    targetBindingDigest: m.targetBindingDigest,
    capabilityFingerprint: m.target.capabilityFingerprint,
    contextGeneration: m.contextGeneration,
    sourceRevision: m.sourceRevision,
    budgetDigest: conversationContextDigest(m.budget),
    artifactOwners: ['archive']
  })
  expect(() =>
    runJournalTransaction(db, () =>
      saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proof)
    )
  ).toThrow()
})

it('refuses revoked and old-generation export claims despite prior capability proof', () => {
  const m = manifest()
  const archive = contextSourceArchive('session-a')
  installArchiveProof()
  db.prepare('DELETE FROM conversation_attachment_claims').run()
  expect(() =>
    runJournalTransaction(db, () =>
      saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
    )
  ).toThrow()
  installArchiveProof()
  db.prepare('DELETE FROM conversation_export_sources').run()
  db.prepare('INSERT INTO conversation_export_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    'conv',
    0,
    'session-a',
    'e',
    1,
    m.projection[0].version.sha256,
    archive.sources[0]!.frameOffset,
    archive.sources[0]!.byteOffset,
    archive.sources[0]!.byteLength
  )
  expect(() =>
    runJournalTransaction(db, () =>
      saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
    )
  ).toThrow()
})
it('revalidates retrievable-only coverage instead of treating a past locator receipt as availability', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () => {
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), proofFor(m))
  })
  const covered = readConversationCoverage(db, 'session-b', 1, 1)
  expect(planConversationDelta(m, covered)).toHaveLength(1)
  expect(planConversationDelta(m, covered, () => true)).toEqual([])
  expect(planConversationDelta(m, covered, () => false)).toHaveLength(1)
})
it('rejects unverified item coordinates attached to an otherwise valid canonical row', () => {
  const m = manifest()
  installArchiveProof()
  m.projection[0].version.source.itemId = 'forged-item'
  m.projection[0].version.source.itemRevision = 99
  expect(() =>
    runJournalTransaction(db, () =>
      saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
    )
  ).toThrow()
})
it('invalidates preparation on proof cascade and replacement, but not rolled-back claim mutations', () => {
  installArchiveProof()
  const revision = () =>
    db.prepare('SELECT revision FROM conversation_context_authority_revision WHERE id=1').get()
      ?.revision
  const before = revision()
  expect(() =>
    runJournalTransaction(db, () => {
      db.prepare('DELETE FROM conversation_attachment_claims').run()
      throw new Error('rollback')
    })
  ).toThrow('rollback')
  expect(revision()).toBe(before)
  const replacement = contextSourceArchive('session-b')
  db.prepare('INSERT OR REPLACE INTO conversation_attachment_claims VALUES(?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    replacement.sha256,
    replacement.byteLength,
    2
  )
  expect(revision()).toBeGreaterThan(Number(before))
  const replaced = revision()
  db.prepare('DELETE FROM conversation_attachment_claims').run()
  expect(revision()).toBeGreaterThan(Number(replaced))
  expect(db.prepare('SELECT COUNT(*) count FROM conversation_export_sources').get()?.count).toBe(0)
})
it('rechecks host retrieval capability at receipt time rather than trusting preparation', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
  )
  expect(() =>
    runJournalTransaction(db, () =>
      recordConversationCoverage(
        db,
        m.manifestId,
        'accepted',
        () => receipt(m),
        () => null
      )
    )
  ).toThrow('unverified')
  expect(readConversationCoverage(db, 'session-b', 1, 1)).toEqual([])
})
it('does not treat a summary receipt as continuing access to its backing evidence', () => {
  const m = manifest()
  const part = { ...m.projection[0], representation: 'summarized' as const, text: 'source summary' }
  const changed = { ...m, projection: [part] }
  const covered = [
    {
      manifestId: m.manifestId,
      receiptId: 'accepted',
      targetSessionId: 'session-b',
      targetBindingDigest: m.targetBindingDigest,
      contextGeneration: 1,
      nativeBindingGeneration: 1,
      version: part.version,
      representation: part.representation,
      representationDigest: conversationContextDigest(part)
    }
  ]
  expect(planConversationDelta(changed, covered)).toEqual([part])
  expect(planConversationDelta(changed, covered, () => true)).toEqual([])
})

async function indexedManifest(selected?: ConversationContextRepresentation[]) {
  const initial = manifest()
  if (!selected) {
    installArchiveProof()
  }
  const parts = selected ?? initial.projection
  const result = await compileConversationContextPages({
    db,
    expected: {
      sourceCount: parts.length,
      orderedVersionDigest: createHash('sha256')
        .update(parts.map((part) => `${conversationEvidenceKey(part.version)}\n`).join(''))
        .digest('hex')
    },
    rows: (async function* () {
      for (const part of parts) {
        yield {
          original: {
            version: part.version,
            text: serializeJournalRow(contextSourceRow(part.version.source.sequence)),
            kind: 'historical-data' as const,
            gaps: []
          },
          representation: part
        }
      }
    })(),
    maxInlineBytes: 1024 * 1024,
    conversationId: initial.conversationId,
    contextGeneration: 1,
    sourceRevision: initial.sourceRevision,
    target: initial.target,
    policy: 'budgeted',
    mandatory: [],
    budget: initial.budget,
    countTokens: () => 100,
    now: 10,
    signal: new AbortController().signal
  })
  if (result.kind !== 'compiled') {
    throw new Error(result.reason)
  }
  const m = result.manifest
  installDeliveryIntent(m)
  const read = () => ({
    ...proofFor(m)(),
    evidenceIndex: m.evidenceIndex,
    sourceEnumeration: {
      sourceCount: parts.length,
      orderedVersionDigest: createHash('sha256')
        .update(parts.map((part) => `${conversationEvidenceKey(part.version)}\n`).join(''))
        .digest('hex')
    }
  })
  await authorizeConversationManifestIndex(db, m, read, new AbortController().signal)
  return { m, read }
}
it('joins a sealed index receipt without copying representations into coverage and checks current access', async () => {
  const { m, read } = await indexedManifest()
  runJournalTransaction(db, () => {
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), read)
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), read)
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), read)
  })
  expect(db.prepare('SELECT COUNT(*) n FROM conversation_context_coverage').get()?.n).toBe(0)
  expect(db.prepare('SELECT COUNT(*) n FROM conversation_context_index_receipts').get()?.n).toBe(1)
  const query = { manifestId: m.manifestId, receiptId: 'accepted', after: 0, limit: 1 }
  expect(readConversationIndexedCoveragePage(db, query, read)).toMatchObject([
    { ordinal: 1, entry: { representation: 'retrievable-only', targetSessionId: 'session-b' } }
  ])
  expect(readConversationIndexedCoveragePage(db, { ...query, after: 1 }, read)).toEqual([])
  expect(() => readConversationIndexedCoveragePage(db, query, () => null)).toThrow('unverified')
  expect(() =>
    readConversationIndexedCoveragePage(db, query, () => ({
      ...read(),
      capabilityFingerprint: 'changed'
    }))
  ).toThrow('unverified')
  db.prepare('DELETE FROM conversation_attachment_claims').run()
  expect(() => readConversationIndexedCoveragePage(db, query, read)).toThrow()
})

it('rolls back indexed receipt publication and denies old-generation page access', async () => {
  const { m, read } = await indexedManifest()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), read)
  )
  expect(() =>
    runJournalTransaction(db, () => {
      recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), read)
      throw new Error('later commit failure')
    })
  ).toThrow('later commit failure')
  expect(db.prepare('SELECT COUNT(*) n FROM conversation_context_index_receipts').get()?.n).toBe(0)
  runJournalTransaction(db, () =>
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), read)
  )
  db.prepare(
    "UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2) WHERE conversation_id='conv'"
  ).run()
  expect(() =>
    readConversationIndexedCoveragePage(
      db,
      { manifestId: m.manifestId, receiptId: 'accepted', after: 0, limit: 1 },
      read
    )
  ).toThrow()
})

it('plans indexed deltas by source representation receipt and requires live retrieval access', async () => {
  const { m, read } = await indexedManifest()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), read)
  )
  const query = { manifestId: m.manifestId, after: 0, limit: 1 }
  expect(planConversationIndexedDeltaPage(db, query, read, () => true).parts).toHaveLength(1)
  runJournalTransaction(db, () =>
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), read)
  )
  expect(planConversationIndexedDeltaPage(db, query, read, () => true)).toMatchObject({
    examinedThrough: 1,
    complete: true,
    parts: []
  })
  expect(planConversationIndexedDeltaPage(db, query, read).parts).toHaveLength(1)
  expect(() => planConversationDelta(m, [])).toThrow('paged')
})

it('keeps same text from a different source and changed representations in indexed deltas', async () => {
  const first = await indexedManifest()
  runJournalTransaction(db, () => {
    saveConversationManifest(
      db,
      first.m,
      consentForConversationManifest(first.m, 'user'),
      first.read
    )
    recordConversationCoverage(
      db,
      first.m.manifestId,
      'accepted',
      () => receipt(first.m),
      first.read
    )
  })
  const part = manifest().projection[0]
  const secondText = serializeJournalRow(contextSourceRow(2))
  const archive = contextSourceArchive('session-a', [contextSourceRow(), contextSourceRow(2)])
  const second = {
    ...part,
    version: {
      source: { ...part.version.source, sequence: 2 },
      sha256: createHash('sha256').update(secondText).digest('hex')
    }
  }
  db.prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)').run(
    'session-a',
    'e',
    2,
    2,
    secondText
  )
  db.prepare('INSERT INTO conversation_source_attribution VALUES(?,?,?,?)').run(
    'session-a',
    'e',
    2,
    'segment'
  )
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('fixture2', 'session-a', 'e', 2)
  db.prepare('INSERT INTO conversation_source_versions VALUES(?,?,?,?,?,?,?)').run(
    'session-a',
    'e',
    2,
    second.version.sha256,
    Buffer.byteLength(secondText),
    'item',
    0
  )
  db.prepare(
    "UPDATE conversation_attachment_claims SET sha256=?,byte_length=? WHERE owner_id='archive'"
  ).run(archive.sha256, archive.byteLength)
  db.prepare('INSERT INTO conversation_export_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    'conv',
    1,
    'session-a',
    'e',
    2,
    second.version.sha256,
    archive.sources[1]!.frameOffset,
    archive.sources[1]!.byteOffset,
    archive.sources[1]!.byteLength
  )
  db.prepare('INSERT INTO conversation_export_disclosures VALUES(?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    'conv',
    1,
    first.m.targetBindingDigest,
    JSON.stringify(['session-a', 'e', 2, null, null, null]),
    second.version.sha256,
    JSON.stringify({
      version: second.version,
      contextGeneration: 1,
      targetBindingDigest: first.m.targetBindingDigest,
      action: 'include',
      reason: 'user-policy',
      critical: false
    })
  )
  const changed = await indexedManifest([part, second])
  runJournalTransaction(db, () =>
    saveConversationManifest(
      db,
      changed.m,
      consentForConversationManifest(changed.m, 'user'),
      changed.read
    )
  )
  expect(
    planConversationIndexedDeltaPage(
      db,
      { manifestId: changed.m.manifestId, after: 0, limit: 2 },
      changed.read,
      () => true
    ).parts.map((row) => row.part.version.source.sequence)
  ).toEqual([2])
  const summary = {
    ...part,
    representation: 'summarized' as const,
    text: 'A source summary',
    spans: [{ version: part.version, startByte: 0, endByte: Buffer.byteLength(contextSourceText) }]
  }
  const revised = await indexedManifest([summary, second])
  runJournalTransaction(db, () =>
    saveConversationManifest(
      db,
      revised.m,
      consentForConversationManifest(revised.m, 'user'),
      revised.read
    )
  )
  expect(
    planConversationIndexedDeltaPage(
      db,
      { manifestId: revised.m.manifestId, after: 0, limit: 2 },
      revised.read,
      () => true
    ).parts
  ).toHaveLength(2)
})

it('binds coverage to its original durable operation and fence while preserving historical acceptance', () => {
  const m = manifest()
  installArchiveProof()
  runJournalTransaction(db, () =>
    saveConversationManifest(db, m, consentForConversationManifest(m, 'user'), proofFor(m))
  )
  for (const changed of [
    { ...receipt(m), operationKey: 'unrelated' },
    { ...receipt(m), activationFence: 99 }
  ]) {
    expect(() =>
      runJournalTransaction(db, () =>
        recordConversationCoverage(db, m.manifestId, 'accepted', () => changed, proofFor(m))
      )
    ).toThrow('unverified')
  }
  expect(readConversationCoverage(db, 'session-b', 1, 1)).toEqual([])
  db.prepare(
    "UPDATE conversations SET record_json=json_set(record_json,'$.pendingOperationKey','new-operation','$.activationFence',99)"
  ).run()
  runJournalTransaction(db, () =>
    recordConversationCoverage(db, m.manifestId, 'accepted', () => receipt(m), proofFor(m))
  )
  expect(readConversationCoverage(db, 'session-b', 1, 1)).toHaveLength(1)
})
it('reuses exact source bytes after locator renewal without weakening source or native binding identity', () => {
  const m = manifest()
  const exact = { ...m.projection[0], representation: 'exact' as const, text: contextSourceText }
  const previous = { ...m, projection: [exact] }
  const entry = {
    manifestId: m.manifestId,
    receiptId: 'accepted',
    targetSessionId: m.target.sessionId,
    targetBindingDigest: m.targetBindingDigest,
    contextGeneration: 1,
    nativeBindingGeneration: 1,
    version: exact.version,
    representation: exact.representation,
    representationDigest: conversationRepresentationCoverageDigest(exact)
  }
  const renewed = { ...exact, artifactId: 'new-upload-owner' }
  expect(planConversationDelta({ ...previous, projection: [renewed] }, [entry])).toEqual([])
  expect(
    planConversationDelta(
      {
        ...previous,
        projection: [
          {
            ...renewed,
            version: { ...renewed.version, source: { ...renewed.version.source, sequence: 2 } }
          }
        ]
      },
      [entry]
    )
  ).toHaveLength(1)
  expect(
    planConversationDelta(
      { ...previous, target: { ...previous.target, nativeBindingGeneration: 2 } },
      [entry]
    )
  ).toHaveLength(1)
})
it('joins prior exact coverage after a renewed export owner replaces the old locator', async () => {
  installArchiveProof()
  const part = {
    ...manifest().projection[0],
    representation: 'exact' as const,
    text: contextSourceText
  }
  const first = await indexedManifest([part])
  runJournalTransaction(db, () => {
    saveConversationManifest(
      db,
      first.m,
      consentForConversationManifest(first.m, 'user'),
      first.read
    )
    recordConversationCoverage(
      db,
      first.m.manifestId,
      'accepted',
      () => receipt(first.m),
      first.read
    )
  })
  const version = part.version
  const archive = contextSourceArchive('session-a')
  db.prepare('INSERT INTO conversation_attachment_claims VALUES(?,?,?,?,?,?)').run(
    'renewed',
    'upload2',
    'evidence.jsonl',
    archive.sha256,
    archive.byteLength,
    1
  )
  db.prepare('INSERT INTO conversation_export_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'renewed',
    'upload2',
    'evidence.jsonl',
    'conv',
    1,
    'session-a',
    'e',
    1,
    version.sha256,
    archive.sources[0]!.frameOffset,
    archive.sources[0]!.byteOffset,
    archive.sources[0]!.byteLength
  )
  db.prepare('INSERT INTO conversation_export_disclosures VALUES(?,?,?,?,?,?,?,?,?)').run(
    'renewed',
    'upload2',
    'evidence.jsonl',
    'conv',
    1,
    first.m.targetBindingDigest,
    JSON.stringify(['session-a', 'e', 1, null, null, null]),
    version.sha256,
    JSON.stringify({
      version,
      contextGeneration: 1,
      targetBindingDigest: first.m.targetBindingDigest,
      action: 'include',
      reason: 'user-policy',
      critical: false
    })
  )
  db.prepare("DELETE FROM conversation_attachment_claims WHERE owner_id='archive'").run()
  const renewed = await indexedManifest([{ ...part, artifactId: 'renewed' }])
  runJournalTransaction(db, () =>
    saveConversationManifest(
      db,
      renewed.m,
      consentForConversationManifest(renewed.m, 'user'),
      renewed.read
    )
  )
  expect(
    planConversationIndexedDeltaPage(
      db,
      { manifestId: renewed.m.manifestId, after: 0, limit: 1 },
      renewed.read
    )
  ).toMatchObject({ complete: true, parts: [] })
})
