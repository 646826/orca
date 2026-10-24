import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-evidence'
import type {
  ConversationContextOriginal,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  prepareConversationExactRows,
  createConversationPreparationRows
} from './conversation-preparation-rows'
import { freezeConversationPreparationSources } from './conversation-preparation-sources'
import { readSegments } from './conversation-read-model'
import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'

const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => fixtures.splice(0).forEach((f) => f.close()))

async function setup(output: string) {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const segment = readSegments(f.host.db, intent.conversationId).find(
    (s) => s.sessionId === 'session-a'
  )!
  const bodies = [
    {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'Never delete 日本語🙂 files.' }]
    },
    {
      kind: 'tool-call' as const,
      name: 'read',
      input: { path: 'test.ts' },
      state: 'completed' as const,
      output: {
        head: output,
        byteLength: Buffer.byteLength(output),
        digest: createHash('sha256').update(output).digest('hex'),
        truncated: false
      }
    }
  ]
  f.host.transaction((db) => {
    bodies.forEach((body, index) => {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq: index + 2,
        ts: 1,
        fence: 1,
        itemId: `item-${index}`,
        revision: 1,
        body
      })
      attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
        sessionId: 'session-a',
        epoch: 'epoch-session-a',
        endSequence: index + 2
      })
    })
  })
  const signal = new AbortController().signal
  const snapshot = await freezeConversationPreparationSources(f.host.db, intent, signal)
  return {
    f,
    snapshot,
    signal,
    input: {
      db: f.host.db,
      store: new AgentSessionAttachmentStore(
        agentSessionAttachmentStoreRoot(f.host.stateDirectory),
        { hasSession: () => true }
      ),
      stateDirectory: f.host.stateDirectory,
      conversationId: intent.conversationId,
      snapshot,
      targetBindingDigest: 'a'.repeat(64),
      maxBytes: 1024 * 1024,
      signal,
      projection: 'tools' as const
    }
  }
}

it('prepares all frozen source versions while projecting an oversized tool result and keeping user constraints exact', async () => {
  const { input, snapshot } = await setup(`${'甲🙂'.repeat(200000)}critical-final-output`)
  const prepared = createConversationPreparationRows(input)
  const rows: {
    original: ConversationContextOriginal
    representation: ConversationContextRepresentation
  }[] = []
  for await (const row of prepared.rows) {
    rows.push(row)
    if (row.representation.representation === 'summarized') {
      expect(await prepared.resolveRequirement(row.original.version)).toMatchObject({
        sourceRevision: snapshot.sourceRevision,
        requirement: 'projection-approved'
      })
    }
  }
  expect(rows).toHaveLength(snapshot.enumeration.sourceCount)
  expect(rows[1].representation.text).toContain('Never delete 日本語🙂 files.')
  expect(rows[1].representation.representation).toBe('exact')
  expect(rows[2].original.text).toBeUndefined()
  expect(rows[2].original.byteLength).toBeGreaterThan(1024 * 1024)
  expect(rows[2].representation).toMatchObject({
    representation: 'summarized',
    artifactId: expect.any(String),
    spans: [
      { version: rows[2].original.version, startByte: 0, endByte: rows[2].original.byteLength }
    ]
  })
  expect(await prepared.resolveRequirement(rows[2].original.version)).toBeNull()
})

it('refuses a known credential inside projected-away tool bytes before publishing an artifact', async () => {
  const { input, f } = await setup(`${'safe '.repeat(200000)}sk-proj-${'Z'.repeat(40)}`)
  const prepared = createConversationPreparationRows(input)
  await expect(
    (async () => {
      for await (const _row of prepared.rows) {
        /* consume */
      }
    })()
  ).rejects.toThrow('known-sensitive-source')
  expect(
    f.host.db
      .prepare('SELECT COUNT(*) count FROM conversation_source_versions WHERE sequence=3')
      .get()?.count
  ).toBe(0)
})

it('compiles exact canonical bytes with complete Unicode suffix and independently checked source enumeration', async () => {
  const { input, snapshot, f } = await setup('tool result 日本語🙂 final sentence')
  const originals: ConversationContextOriginal[] = []
  const produced = prepareConversationExactRows(input)
  const compiled = await compileConversationContextPages({
    db: f.host.db,
    conversationId: input.conversationId,
    contextGeneration: snapshot.contextGeneration,
    sourceRevision: snapshot.sourceRevision,
    target: {
      sessionId: 'session-b',
      provider: 'codex',
      accountBindingDigest: 'account',
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'model',
      retrieval: 'unsupported'
    },
    policy: 'budgeted',
    budget: null,
    mandatory: [],
    countTokens: (text) => Buffer.byteLength(text),
    signal: input.signal,
    now: 1,
    maxInlineBytes: input.maxBytes,
    expected: snapshot.enumeration,
    rows: (async function* () {
      for await (const row of produced) {
        originals.push(row.original)
        yield row
      }
    })()
  })
  expect(compiled.kind).toBe('compiled')
  expect(originals).toHaveLength(snapshot.enumeration.sourceCount)
  const ordered = createHash('sha256')
  for (const original of originals) {
    const raw = f.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq=?')
      .get(
        original.version.source.sessionId,
        original.version.source.epoch,
        original.version.source.sequence
      )?.row_json
    expect(original.text).toBe(raw)
    expect(typeof raw).toBe('string')
    if (typeof raw !== 'string') {
      throw new Error('Missing canonical source')
    }
    expect(original.version.sha256).toBe(createHash('sha256').update(raw).digest('hex'))
    ordered.update(conversationEvidenceKey(original.version)).update('\n')
  }
  expect(ordered.digest('hex')).toBe(snapshot.enumeration.orderedVersionDigest)
  expect(originals[2].text).toContain('日本語🙂 final sentence')
})

it('refuses exact and projected inline overflow and cancelled traversal without a partial successful result', async () => {
  const { input } = await setup('retained result')
  async function consume(rows: ReturnType<typeof prepareConversationExactRows>) {
    for await (const _row of rows) {
      /* exhaust before publication */
    }
  }
  await expect(consume(prepareConversationExactRows({ ...input, maxBytes: 1 }))).rejects.toThrow(
    'resource-limit'
  )
  await expect(
    consume(createConversationPreparationRows({ ...input, maxBytes: 1 }).rows)
  ).rejects.toThrow('resource-limit')
  const controller = new AbortController()
  controller.abort()
  await expect(
    consume(prepareConversationExactRows({ ...input, signal: controller.signal }))
  ).rejects.toThrow()
})
