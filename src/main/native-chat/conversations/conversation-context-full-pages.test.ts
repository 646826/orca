import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import type { ConversationContextInput } from '../../../shared/conversation-handoff'
let db: Database.Database, root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-full-pages-'))
  db = openJournalDatabase(join(root, 'db')).db
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const text = JSON.stringify({
    v: 1,
    kind: 'item',
    epoch: 'e',
    seq: 1,
    ts: 1,
    fence: 1,
    itemId: 'user',
    revision: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Never delete user files. 日本語🙂' }]
    }
  })
  const version = {
    source: { sessionId: 'a', epoch: 'e', sequence: 1 },
    sha256: createHash('sha256').update(text).digest('hex')
  }
  const original = { version, text, kind: 'user' as const, gaps: [] }
  const representation = { version, text, representation: 'exact' as const, spans: [] }
  const input: Omit<ConversationContextInput, 'originals' | 'projection'> = {
    conversationId: 'c',
    contextGeneration: 1,
    sourceRevision: 'frozen',
    policy: 'full',
    target: {
      sessionId: 'b',
      provider: 'codex',
      accountBindingDigest: 'account',
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'model',
      retrieval: 'unsupported'
    },
    mandatory: [
      { id: 'keep', text: 'Never delete user files.', sources: [version], supersedes: [] }
    ],
    budget: {
      capacity: 100000,
      occupied: 0,
      reserved: 100,
      confidence: 'upper-bound',
      targetFingerprint: 'caps',
      nativeBindingGeneration: 1,
      model: 'model',
      accountBindingDigest: 'account',
      observedAt: 1,
      validUntil: 20
    },
    // Synthetic byte-unit capacity, not a provider token estimate.
    countTokens: (text) => Buffer.byteLength(text),
    inputTokenConfidence: 'exact',
    now: 10,
    signal: new AbortController().signal
  }
  return {
    input,
    original,
    representation,
    expected: {
      sourceCount: 1,
      orderedVersionDigest: createHash('sha256')
        .update(conversationEvidenceKey(version))
        .update('\n')
        .digest('hex')
    }
  }
}
it('compiles nonempty full indexed delivery with every exact source and mandatory constraint inline', async () => {
  const f = fixture()
  const result = await compileConversationContextPages({
    db,
    ...f.input,
    expected: f.expected,
    maxInlineBytes: 10000,
    rows: (async function* () {
      yield f
    })()
  })
  expect(result.kind).toBe('compiled')
  if (result.kind === 'compiled') {
    expect(result.manifest.projection).toEqual([f.representation])
    expect(result.manifest.evidenceIndex?.partCount).toBe(1)
    expect(result.manifest.completeness).toBe('available-canonical')
    expect(result.manifest.mandatory).toEqual(f.input.mandatory)
  }
})
it.each(['unknown', 'unknown-estimator', 'overflow', 'late-revision', 'resource'] as const)(
  'refuses full delivery for %s without a surviving compilation',
  async (scenario) => {
    const f = fixture()
    if (scenario === 'unknown') {
      f.input.budget = null
    }
    if (scenario === 'unknown-estimator') {
      f.input.inputTokenConfidence = 'unknown'
    }
    if (scenario === 'overflow') {
      f.input.budget!.capacity = 100
    }
    if (scenario === 'late-revision') {
      f.original.version.source.sequence = 2
    }
    const result = await compileConversationContextPages({
      db,
      ...f.input,
      expected: f.expected,
      maxInlineBytes: scenario === 'resource' ? 10 : 10000,
      rows: (async function* () {
        yield f
      })()
    })
    expect(result).toMatchObject({
      kind: 'refused',
      reason: {
        unknown: 'unknown-budget',
        'unknown-estimator': 'unknown-budget',
        overflow: 'overflow',
        'late-revision': 'missing-representation',
        resource: 'resource-limit'
      }[scenario]
    })
    expect(db.prepare('SELECT COUNT(*) n FROM conversation_manifest_compilations').get()?.n).toBe(0)
  }
)
it.each(['absent', 'stale', 'approved'] as const)(
  'classifies canonical user text despite a false assistant label: %s',
  async (decision) => {
    const f = fixture()
    f.input.policy = 'budgeted'
    f.input.mandatory = []
    f.input.target.retrieval = 'verified'
    const original = { ...f.original, kind: 'assistant' as const, artifactId: 'archive' }
    const representation = {
      version: original.version,
      representation: 'retrievable-only' as const,
      artifactId: 'archive',
      spans: []
    }
    const result = await compileConversationContextPages({
      db,
      ...f.input,
      expected: f.expected,
      maxInlineBytes: 10000,
      rows: (async function* () {
        yield { original, representation }
      })(),
      resolveRequirement: async (version) =>
        decision === 'absent'
          ? null
          : {
              version,
              contextGeneration: 1,
              sourceRevision: decision === 'stale' ? 'old' : 'frozen',
              requirement: 'projection-approved'
            }
    })
    expect(result.kind).toBe(decision === 'approved' ? 'compiled' : 'refused')
    if (result.kind === 'refused') {
      expect(result.reason).toBe('mandatory-not-inline')
    }
  }
)
