import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from '../agent-session-journal/journal-database'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import type {
  ConversationContextInput,
  ConversationContextOriginal,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
let db: Database.Database, root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-paged-'))
  db = openJournalDatabase(join(root, 'db')).db
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})
function fixture(count = 1000) {
  const hash = createHash('sha256')
  const entries = Array.from(
    { length: count },
    (
      _,
      i
    ): {
      original: ConversationContextOriginal
      representation: ConversationContextRepresentation
    } => {
      const version = {
        source: { sessionId: 'a', epoch: 'e', sequence: i + 1 },
        sha256: createHash('sha256').update('original').digest('hex')
      }
      hash.update(conversationEvidenceKey(version)).update('\n')
      return {
        original: {
          version,
          byteLength: 8,
          artifactId: 'archive',
          kind: 'historical-data',
          gaps: []
        },
        representation: {
          version,
          representation: 'retrievable-only',
          artifactId: 'archive',
          spans: []
        }
      }
    }
  )
  const input: Omit<ConversationContextInput, 'originals' | 'projection'> = {
    conversationId: 'conv',
    contextGeneration: 1,
    sourceRevision: 'frozen',
    target: {
      sessionId: 'b',
      provider: 'codex',
      accountBindingDigest: 'account',
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'model',
      retrieval: 'verified'
    },
    policy: 'budgeted',
    mandatory: [],
    budget: null,
    countTokens: (text) => Buffer.byteLength(text),
    signal: new AbortController().signal,
    now: 10
  }
  return {
    entries,
    input,
    expected: { sourceCount: count, orderedVersionDigest: hash.digest('hex') },
    resolveRequirement: async (version: ConversationContextOriginal['version']) => ({
      version,
      contextGeneration: input.contextGeneration,
      sourceRevision: input.sourceRevision,
      requirement: 'projection-approved' as const
    })
  }
}
it('keeps a thousand explicit source representations pageable and measures only actual inline envelope', async () => {
  const f = fixture()
  const result = await compileConversationContextPages({
    db,
    ...f.input,
    expected: f.expected,
    resolveRequirement: f.resolveRequirement,
    rows: (async function* () {
      yield* f.entries
    })(),
    maxInlineBytes: 4096
  })
  expect(result.kind).toBe('compiled')
  if (result.kind === 'compiled') {
    expect(result.manifest.projection).toEqual([])
    expect(result.manifest.evidenceIndex?.partCount).toBe(1000)
    expect(result.manifest.inputTokens).toBeLessThan(4096)
  }
})
it('refuses an omitted source and any attempt to demote user instructions to archive-only', async () => {
  const f = fixture(2)
  expect(
    await compileConversationContextPages({
      db,
      ...f.input,
      expected: f.expected,
      resolveRequirement: f.resolveRequirement,
      rows: (async function* () {
        yield f.entries[0]
      })(),
      maxInlineBytes: 4096
    })
  ).toMatchObject({ kind: 'refused', reason: 'missing-representation' })
  f.entries[0].original.kind = 'user'
  expect(
    await compileConversationContextPages({
      db,
      ...f.input,
      expected: f.expected,
      rows: (async function* () {
        yield* f.entries
      })(),
      maxInlineBytes: 4096
    })
  ).toMatchObject({ kind: 'refused', reason: 'mandatory-not-inline' })
})
it('allows an explicitly approved nonmandatory user projection bound to the frozen source', async () => {
  const f = fixture(1)
  f.entries[0].original.kind = 'user'
  const result = await compileConversationContextPages({
    db,
    ...f.input,
    expected: f.expected,
    rows: (async function* () {
      yield* f.entries
    })(),
    maxInlineBytes: 4096,
    resolveRequirement: async (version) => ({
      version,
      contextGeneration: 1,
      sourceRevision: 'frozen',
      requirement: 'projection-approved'
    })
  })
  expect(result.kind).toBe('compiled')
})
it('validates cross-source summary spans through bounded original lookup', async () => {
  const f = fixture(2)
  const cited = f.entries[1].original
  f.entries[0].representation = {
    ...f.entries[0].representation,
    representation: 'summarized',
    text: 'The two original results agree.',
    spans: [
      { version: f.entries[0].original.version, startByte: 0, endByte: 8 },
      { version: cited.version, startByte: 0, endByte: 8 }
    ]
  }
  const result = await compileConversationContextPages({
    db,
    ...f.input,
    expected: f.expected,
    resolveRequirement: f.resolveRequirement,
    rows: (async function* () {
      yield* f.entries
    })(),
    maxInlineBytes: 4096,
    resolveOriginal: async (version) =>
      conversationEvidenceKey(version) === conversationEvidenceKey(cited.version) ? cited : null
  })
  expect(result.kind).toBe('compiled')
})

it('refuses opaque user bytes mislabeled as historical data without a trusted projection decision', async () => {
  const f = fixture(1)
  expect(
    await compileConversationContextPages({
      db,
      ...f.input,
      expected: f.expected,
      rows: (async function* () {
        yield* f.entries
      })(),
      maxInlineBytes: 4096
    })
  ).toMatchObject({ kind: 'refused', reason: 'mandatory-not-inline' })
})
