import { contextSourceArchive, contextSourceText } from './conversation-context-source-row.fixture'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { compileConversationContext, conversationEvidenceKey } from './conversation-context-policy'
import { conversationContextDigest } from './conversation-context-consent'
import type { ConversationContextManifest } from '../../../shared/conversation-handoff'
import type { ConversationDeliveryEvidence } from '../../../shared/conversation-wire'
import {
  conversationContextAccountDigest,
  conversationContextSourceRevision
} from './conversation-context-authority'
let root: string
export let db: Database.Database
const location = {
  executionHostId: 'local' as const,
  wslDistro: null,
  workspaceId: 'folder',
  workspaceKind: 'folder' as const
}
const targetIdentity = {
  provider: 'codex',
  accountHome: { variable: 'AGENT_HOME', path: '/account' },
  location
}
const accountDigest = conversationContextAccountDigest(targetIdentity)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-context-'))
  db = openJournalDatabase(join(root, 'journal.db')).db
  db.prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)').run(
    'session-a',
    'e',
    1,
    1,
    contextSourceText
  )
  db.prepare('INSERT INTO conversations VALUES(?,?)').run(
    'conv',
    JSON.stringify({
      conversationId: 'conv',
      location,
      revision: 1,
      contextGeneration: 1,
      activationFence: 1,
      activeSegmentId: 'segment',
      pendingOperationKey: null
    })
  )
  for (const sessionId of ['session-a', 'session-b']) {
    const record = foundAgentSessionRecord(
      { ...targetIdentity, sessionId },
      { claimKeyId: sessionId, now: 1 }
    )
    db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)').run(
      sessionId,
      JSON.stringify(record)
    )
    db.prepare('INSERT INTO conversation_participants VALUES(?,?,?)').run(
      sessionId,
      'conv',
      JSON.stringify({
        ...targetIdentity,
        sessionId,
        conversationId: 'conv',
        nativeBindingGeneration: 1,
        contextGeneration: 1,
        state: sessionId === 'session-a' ? 'active' : 'parked'
      })
    )
  }
  db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
    'segment',
    'conv',
    1,
    JSON.stringify({
      segmentId: 'segment',
      conversationId: 'conv',
      ordinal: 1,
      sessionId: 'session-a',
      contextGeneration: 1,
      activationFence: 1,
      nativeBindingGeneration: 1,
      startSequence: 1,
      boundary: { sessionId: 'session-a', epoch: 'e', endSequence: 1 }
    })
  )
  db.prepare('INSERT INTO conversation_source_attribution VALUES(?,?,?,?)').run(
    'session-a',
    'e',
    1,
    'segment'
  )
  db.prepare('INSERT INTO journal_epoch_pins VALUES(?,?,?,?)').run('fixture', 'session-a', 'e', 1)
  db.prepare('INSERT INTO conversation_source_versions VALUES(?,?,?,?,?,?,?)').run(
    'session-a',
    'e',
    1,
    createHash('sha256').update(contextSourceText).digest('hex'),
    Buffer.byteLength(contextSourceText),
    'item',
    0
  )
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})
export function manifest(): ConversationContextManifest {
  const version = {
    source: { sessionId: 'session-a', epoch: 'e', sequence: 1 },
    sha256: createHash('sha256').update(contextSourceText).digest('hex')
  }
  const result = compileConversationContext({
    conversationId: 'conv',
    contextGeneration: 1,
    sourceRevision: conversationContextSourceRevision(db, 'conv', 'session-b'),
    target: {
      sessionId: 'session-b',
      provider: 'codex',
      accountBindingDigest: accountDigest,
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'cap',
      model: 'model',
      retrieval: 'verified'
    },
    policy: 'budgeted',
    originals: [{ version, text: contextSourceText, kind: 'historical-data', gaps: [] }],
    projection: [{ version, representation: 'retrievable-only', artifactId: 'archive', spans: [] }],
    mandatory: [],
    budget: {
      capacity: 10000,
      occupied: 0,
      reserved: 100,
      confidence: 'upper-bound',
      model: 'model',
      accountBindingDigest: accountDigest,
      observedAt: 1,
      validUntil: 100,
      targetFingerprint: 'cap',
      nativeBindingGeneration: 1
    },
    countTokens: (text) => Buffer.byteLength(text),
    now: 10,
    signal: new AbortController().signal
  })
  if (result.kind !== 'compiled') {
    throw new Error(result.reason)
  }
  return result.manifest
}
export function installDeliveryIntent(m: ConversationContextManifest): void {
  const evidence = receipt(m)
  db.prepare('INSERT OR IGNORE INTO conversation_switch_intents VALUES(?,?,?)').run(
    evidence.operationKey,
    m.conversationId,
    JSON.stringify({
      operationKey: evidence.operationKey,
      conversationId: m.conversationId,
      targetSessionId: m.target.sessionId,
      contextGeneration: m.contextGeneration,
      activationFence: evidence.activationFence,
      nativeBindingGeneration: m.target.nativeBindingGeneration,
      version: 1,
      phase: 'delivering',
      sourceBoundaries: [],
      candidateSegmentId: null,
      candidateBaseline: [],
      candidateBoundary: evidence.candidateBoundary,
      manifestId: m.manifestId,
      deliveryReceiptId: null
    })
  )
}
export function receipt(m: ConversationContextManifest): ConversationDeliveryEvidence {
  return {
    operationKey: `operation:${m.manifestId}`,
    deliveryReceiptId: 'accepted',
    manifestId: m.manifestId,
    targetSessionId: m.target.sessionId,
    contextGeneration: m.contextGeneration,
    activationFence: 2,
    nativeBindingGeneration: m.target.nativeBindingGeneration,
    sourceBoundaries: [],
    candidateBoundary: { sessionId: 'session-b', epoch: 'b-epoch', endSequence: 1 },
    candidateBaseline: [],
    candidateReadback: []
  }
}
export function installArchiveProof() {
  const m = manifest()
  const archive = contextSourceArchive('session-a')
  installDeliveryIntent(m)
  const fact = {
    version: m.projection[0].version,
    contextGeneration: 1,
    targetBindingDigest: m.targetBindingDigest,
    action: 'include',
    reason: 'user-policy',
    critical: false
  }
  db.prepare('INSERT INTO conversation_attachment_claims VALUES(?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    archive.sha256,
    archive.byteLength,
    1
  )
  db.prepare('INSERT INTO conversation_export_disclosures VALUES(?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    'conv',
    1,
    m.targetBindingDigest,
    JSON.stringify(['session-a', 'e', 1, null, null, null]),
    fact.version.sha256,
    JSON.stringify(fact)
  )
  db.prepare('INSERT INTO conversation_export_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'archive',
    'upload',
    'evidence.jsonl',
    'conv',
    1,
    'session-a',
    'e',
    1,
    createHash('sha256').update(contextSourceText).digest('hex'),
    archive.sources[0]!.frameOffset,
    archive.sources[0]!.byteOffset,
    archive.sources[0]!.byteLength
  )
}
export function proofFor(m: ConversationContextManifest) {
  return () => ({
    manifestDigest: m.digest,
    proofId: 'test-only-capability',
    nativeIdentityDigest: 'fixture-native',
    targetBindingDigest: m.targetBindingDigest,
    capabilityFingerprint: m.target.capabilityFingerprint,
    contextGeneration: m.contextGeneration,
    sourceRevision: m.sourceRevision,
    budgetDigest: conversationContextDigest(m.budget),
    sourceEnumeration: {
      sourceCount: 1,
      orderedVersionDigest: createHash('sha256')
        .update(
          conversationEvidenceKey({
            source: { sessionId: 'session-a', epoch: 'e', sequence: 1 },
            sha256: createHash('sha256').update(contextSourceText).digest('hex')
          })
        )
        .update('\n')
        .digest('hex')
    },
    artifactOwners: ['archive']
  })
}
