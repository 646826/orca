import { prepareConversationSourceAtomReceipt } from './conversation-source-atoms'
import { createHash } from 'node:crypto'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import {
  conversationContextDigest,
  consentForConversationManifest
} from './conversation-context-consent'
import {
  conversationContextAccountDigest,
  conversationContextSourceRevision
} from './conversation-context-authority'
import { authorizeConversationManifestIndex } from './conversation-context-index-authority'
import {
  saveConversationManifest,
  recordConversationCoverage,
  readConversationIndexedCoveragePage
} from './conversation-context-coverage'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../agent-session-journal/journal-database'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { pinJournalEpoch } from '../agent-session-journal/journal-epoch-pins'
import { startJournalRowFold } from '../agent-session-journal/journal-open'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import {
  exportConversationContext,
  streamConversationExportRows
} from './conversation-context-export'
import { projectConversationDisclosedRow } from './conversation-context-projected-row'

let db: Database.Database
let root: string
const pin = { ownerId: 'source', sessionId: 'a', epoch: 'e', endSequence: 4 }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-context-builder-'))
  db = openJournalDatabase(join(root, 'journal.db')).db
  insertJournalRow(db, 'a', {
    kind: 'epoch',
    epoch: 'e',
    seq: 1,
    ts: 1,
    fence: 1,
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread' }
  })
  for (const [seq, revision, text] of [
    [2, 1, 'old decision'],
    [3, 2, '新しい決定🙂\nPreserve the final sentence.']
  ] as const) {
    insertJournalRow(db, 'a', {
      kind: 'item',
      epoch: 'e',
      seq,
      ts: seq,
      fence: 1,
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      itemId: 'codex:message:one',
      revision,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
    })
  }
  insertJournalRow(db, 'a', {
    kind: 'item',
    epoch: 'e',
    seq: 4,
    ts: 4,
    fence: 1,
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    itemId: 'codex:message:two',
    revision: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'same distinct message' }]
    }
  })
  runJournalTransaction(db, () => pinJournalEpoch(db, pin))
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})
it('builds context from the real scoped exporter and authenticated artifact reader', async () => {
  const conversationId = 'conversation'
  insertJournalRow(db, 'a', {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    kind: 'lifecycle-batch',
    epoch: 'e',
    seq: 5,
    ts: 5,
    fence: 1,
    settlementId: 'tool-settled',
    mutations: [
      {
        kind: 'item',
        itemId: 'codex:tool:batch',
        revision: 1,
        body: { kind: 'tool-call', name: 'read', input: { path: 'file.txt' }, state: 'running' }
      },
      {
        kind: 'item',
        itemId: 'codex:tool:batch',
        revision: 2,
        body: {
          kind: 'tool-call',
          name: 'read',
          input: { path: 'file.txt' },
          state: 'completed',
          output: {
            head: '甲🙂'.repeat(40000),
            byteLength: 280000,
            digest: 'a'.repeat(64),
            truncated: false
          }
        }
      }
    ]
  })
  const exportPin = { ...pin, ownerId: 'batch-source', endSequence: 5 }
  runJournalTransaction(db, () => pinJournalEpoch(db, exportPin))
  db.prepare('INSERT INTO conversations VALUES(?,?)').run(
    conversationId,
    JSON.stringify({
      conversationId,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      },
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'segment',
      pendingOperationKey: null
    })
  )
  db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
    'segment',
    conversationId,
    1,
    JSON.stringify({
      segmentId: 'segment',
      conversationId,
      ordinal: 1,
      sessionId: 'a',
      contextGeneration: 1,
      activationFence: 1,
      nativeBindingGeneration: 1,
      startSequence: 1,
      boundary: exportPin
    })
  )
  for (let sequence = 1; sequence <= 5; sequence++) {
    db.prepare('INSERT INTO conversation_source_attribution VALUES(?,?,?,?)').run(
      'a',
      'e',
      sequence,
      'segment'
    )
  }
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
  for (const sessionId of ['a', 'b']) {
    db.prepare('INSERT INTO conversation_participants VALUES(?,?,?)').run(
      sessionId,
      conversationId,
      JSON.stringify({
        ...identity,
        sessionId,
        conversationId,
        nativeBindingGeneration: 1,
        contextGeneration: 1,
        state: sessionId === 'a' ? 'active' : 'parked'
      })
    )
  }
  const target = {
    sessionId: 'b',
    provider: 'codex',
    accountBindingDigest: conversationContextAccountDigest(identity),
    nativeBindingGeneration: 1,
    capabilityFingerprint: 'fixture-caps',
    model: 'model',
    retrieval: 'verified' as const
  }
  const origin = {
    conversationId,
    segmentId: 'segment',
    sessionId: 'a',
    contextGeneration: 1,
    nativeBindingGeneration: 1
  }
  const batchReceipt = prepareConversationSourceAtomReceipt(db, {
    pin: exportPin,
    source: { sessionId: 'a', epoch: 'e', sequence: 5 },
    envelopeOrigin: origin,
    mutationOrigins: [
      { batchIndex: 0, origin },
      { batchIndex: 1, origin }
    ]
  })
  runJournalTransaction(db, () => batchReceipt.write(db))
  const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
    hasSession: () => true
  })
  const scope = {
    db,
    stateDirectory: root,
    store,
    conversationId,
    contextGeneration: 1,
    signal: new AbortController().signal
  }
  const exportRequest = {
    ...scope,
    disclosure: {
      targetBindingDigest: conversationContextDigest(target),
      resolve: (source) => {
        const stored = db
          .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
          .get(source.sessionId, source.epoch, source.sequence)
        if (typeof stored?.row_json !== 'string') {
          return null
        }
        return {
          version: { source, sha256: createHash('sha256').update(stored.row_json).digest('hex') },
          contextGeneration: 1,
          targetBindingDigest: conversationContextDigest(target),
          action: 'include',
          reason: 'user-policy',
          critical: false
        }
      }
    },
    sources: Array.from({ length: 5 }, (_, i) => ({
      segmentId: 'segment',
      pinOwnerId: exportPin.ownerId,
      source: { sessionId: 'a', epoch: 'e', sequence: i + 1 },
      decision: 'include' as const,
      critical: false
    }))
  } satisfies Parameters<typeof exportConversationContext>[0]
  db.prepare("DELETE FROM conversation_source_atoms WHERE atom_path='$.mutations[1]'").run()
  await expect(exportConversationContext(exportRequest)).rejects.toThrow('scope')
  runJournalTransaction(db, () => batchReceipt.write(db))
  const exported = await exportConversationContext(exportRequest)
  const projected: Awaited<ReturnType<typeof projectConversationDisclosedRow>>[] = []
  const fold = startJournalRowFold({ sessionId: 'a', epoch: 'e' })
  for await (const source of streamConversationExportRows({ ...scope, ...exported })) {
    const row = await projectConversationDisclosedRow(source, scope.signal)
    projected.push(row)
    expect(fold.add({ seq: row.row.seq, rowJson: row.projection.text! })).toBe(true)
  }
  const result = {
    originals: projected.map((row) => row.original),
    projection: projected.map((row) => row.projection),
    effective: fold.finish()
  }
  expect(result.effective.damage).toBeNull()
  expect(result.originals[1].text).toContain('old decision')
  expect(result.originals[2].text).toContain('Preserve the final sentence.')
  expect(result.originals[2].version.source.sequence).toBe(3)
  expect(result.originals.map((original) => original.version)).toEqual(
    exported.rows.map((row) => row.version)
  )
  const batchSource = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
    .get('a', 'e', 5)
  expect(result.originals[4].text).toBe(batchSource?.row_json)
  expect(result.effective.state.items.get('codex:tool:batch')).toMatchObject({
    revision: 2,
    body: { kind: 'tool-call', state: 'completed', output: { head: '甲🙂'.repeat(40000) } }
  })
  const versionHash = createHash('sha256')
  result.originals.forEach((original) =>
    versionHash.update(conversationEvidenceKey(original.version)).update('\n')
  )
  const orderedVersionDigest = versionHash.digest('hex')
  const compiled = await compileConversationContextPages({
    db,
    conversationId,
    contextGeneration: 1,
    sourceRevision: conversationContextSourceRevision(db, conversationId, 'b'),
    target,
    policy: 'budgeted',
    mandatory: [],
    budget: null,
    countTokens: (text) => Buffer.byteLength(text),
    now: 1,
    signal: scope.signal,
    maxInlineBytes: 100000,
    expected: { sourceCount: result.originals.length, orderedVersionDigest },
    rows: (async function* () {
      for (const [i, original] of result.originals.entries()) {
        yield {
          original,
          representation:
            original.version.source.sequence === 5
              ? {
                  version: original.version,
                  representation: 'retrievable-only',
                  artifactId: original.artifactId,
                  spans: []
                }
              : result.projection[i]
        }
      }
    })()
  })
  if (compiled.kind !== 'compiled') {
    throw new Error(compiled.reason)
  }
  const manifest = compiled.manifest
  const preparation = () => ({
    proofId: 'synthetic-capability-fixture',
    manifestDigest: manifest.digest,
    targetBindingDigest: manifest.targetBindingDigest,
    capabilityFingerprint: target.capabilityFingerprint,
    contextGeneration: 1,
    sourceRevision: manifest.sourceRevision,
    budgetDigest: conversationContextDigest(null),
    evidenceIndex: manifest.evidenceIndex,
    sourceEnumeration: { sourceCount: result.originals.length, orderedVersionDigest }
  })
  await authorizeConversationManifestIndex(db, manifest, preparation, scope.signal)
  db.prepare('INSERT INTO conversation_switch_intents VALUES(?,?,?)').run(
    'fixture-op',
    conversationId,
    JSON.stringify({
      operationKey: 'fixture-op',
      conversationId,
      targetSessionId: 'b',
      candidateSegmentId: 'fixture-candidate',
      contextGeneration: 1,
      activationFence: 2,
      nativeBindingGeneration: 1,
      version: 1,
      phase: 'delivering',
      sourceBoundaries: [],
      candidateBaseline: [],
      candidateBoundary: { sessionId: 'b', epoch: 'b-epoch', endSequence: 1 },
      manifestId: manifest.manifestId,
      deliveryReceiptId: null
    })
  )
  runJournalTransaction(db, () => {
    saveConversationManifest(
      db,
      manifest,
      consentForConversationManifest(manifest, 'fixture-user'),
      preparation
    )
    recordConversationCoverage(
      db,
      manifest.manifestId,
      'fixture-native-receipt',
      () => ({
        operationKey: 'fixture-op',
        deliveryReceiptId: 'fixture-native-receipt',
        manifestId: manifest.manifestId,
        targetSessionId: 'b',
        contextGeneration: 1,
        activationFence: 2,
        nativeBindingGeneration: 1,
        sourceBoundaries: [],
        candidateBoundary: { sessionId: 'b', epoch: 'b-epoch', endSequence: 1 },
        candidateBaseline: [],
        candidateReadback: []
      }),
      preparation
    )
  })
  expect(
    readConversationIndexedCoveragePage(
      db,
      {
        manifestId: manifest.manifestId,
        receiptId: 'fixture-native-receipt',
        after: 0,
        limit: 128
      },
      preparation
    )
  ).toHaveLength(5)
  expect(result.effective.state.items.get('codex:message:one')?.revision).toBe(2)
})
