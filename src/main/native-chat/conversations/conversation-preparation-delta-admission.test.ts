import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type {
  ConversationContextOriginal,
  ConversationContextRepresentation
} from '../../../shared/conversation-handoff'
import { AgentSessionAttachmentStore } from '../agent-session-attachments/agent-session-attachment-store'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { insertJournalRow } from '../agent-session-journal/journal-row-table'
import { conversationRepresentationCoverageDigest } from './conversation-context-coverage-identity'
import { compileConversationContextPages } from './conversation-context-paged'
import { conversationEvidenceKey } from './conversation-context-policy'
import { conversationDeliveryEnvelope } from './conversation-delivery-plan'
import { prepareConversationExactRows } from './conversation-preparation-rows'
import { freezeConversationPreparationSources } from './conversation-preparation-sources'
import { createConversationSwitchFixture } from './conversation-switch.fixture'

const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()))

async function setup(texts: string[]) {
  const fixture = await createConversationSwitchFixture(undefined, (db) => {
    for (const [index, text] of texts.entries()) {
      insertJournalRow(db, 'session-a', {
        kind: 'item',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch-session-a',
        seq: index + 2,
        ts: index + 2,
        fence: 1,
        itemId: `assistant-${index}`,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
      })
    }
  })
  fixtures.push(fixture)
  const intent = fixture.records.conversations.intent(fixture.operationKey)!
  const signal = new AbortController().signal
  const snapshot = await freezeConversationPreparationSources(fixture.host.db, intent, signal)
  const input = {
    db: fixture.host.db,
    stateDirectory: fixture.host.stateDirectory,
    store: new AgentSessionAttachmentStore(
      agentSessionAttachmentStoreRoot(fixture.host.stateDirectory),
      { hasSession: () => true }
    ),
    conversationId: intent.conversationId,
    snapshot,
    targetBindingDigest: 'a'.repeat(64),
    maxBytes: 1024 * 1024,
    signal
  }
  const canonicalRows = () =>
    fixture.host.db
      .prepare('SELECT row_json FROM journal_rows WHERE session_id=? ORDER BY seq')
      .all('session-a')
      .map((row) => String(row.row_json))
  return { fixture, snapshot, input, canonicalRows }
}

it('admits the measured outgoing envelope without charging its validation originals again', async () => {
  const f = await setup([
    'First result: 日本語🙂 "quoted"\n'.repeat(100),
    'Revised result: use cache v2. 日本語🙂 "quoted"\n'.repeat(100)
  ])
  const rows: {
    original: ConversationContextOriginal
    representation: ConversationContextRepresentation
  }[] = []
  for await (const row of prepareConversationExactRows(f.input)) {
    rows.push(row)
  }
  const input = {
    db: f.fixture.host.db,
    conversationId: f.input.conversationId,
    contextGeneration: f.snapshot.contextGeneration,
    sourceRevision: f.snapshot.sourceRevision,
    target: {
      sessionId: 'session-b',
      provider: 'codex',
      accountBindingDigest: 'account',
      nativeBindingGeneration: 1,
      capabilityFingerprint: 'caps',
      model: 'synthetic-model',
      retrieval: 'unsupported' as const
    },
    policy: 'budgeted' as const,
    budget: null,
    mandatory: [],
    countTokens: (text: string) => Math.ceil(Buffer.byteLength(text) / 4),
    signal: f.input.signal,
    now: 1,
    expected: f.snapshot.enumeration
  }
  const compile = (maxInlineBytes: number) =>
    compileConversationContextPages({
      ...input,
      maxInlineBytes,
      rows: (async function* () {
        yield* rows
      })()
    })
  const reference = await compile(1024 * 1024)
  if (reference.kind !== 'compiled') {
    throw new Error(`Reference compilation refused: ${reference.reason}`)
  }
  const envelope = conversationDeliveryEnvelope(
    reference.manifest,
    reference.manifest.projection.map(conversationRepresentationCoverageDigest)
  )
  const envelopeBytes = Buffer.byteLength(envelope)
  const validationBytes = rows.reduce(
    (bytes, row) =>
      bytes +
      Buffer.byteLength(JSON.stringify(row.original)) +
      Buffer.byteLength(JSON.stringify(row.representation)),
    Buffer.byteLength(JSON.stringify(input.mandatory))
  )
  expect(reference.manifest.evidenceIndex?.partCount).toBe(f.snapshot.enumeration.sourceCount)
  expect(envelope).toContain('evidenceIndex')
  expect(validationBytes).toBeGreaterThan(envelopeBytes)
  const result = await compile(envelopeBytes)
  expect(
    result,
    `outgoing=${envelopeBytes}; validation-only-total=${validationBytes}`
  ).toMatchObject({
    kind: 'compiled'
  })
  if (result.kind === 'compiled') {
    const actualEnvelope = conversationDeliveryEnvelope(
      result.manifest,
      result.manifest.projection.map(conversationRepresentationCoverageDigest)
    )
    expect(Buffer.byteLength(actualEnvelope)).toBe(envelopeBytes)
    expect(result.manifest.inputTokens).toBe(input.countTokens(actualEnvelope))
    expect(result.manifest.projection.map((part) => part.text)).toEqual(f.canonicalRows())
    expect(result.manifest.evidenceIndex?.partCount).toBe(f.snapshot.enumeration.sourceCount)
  }
  expect(await compile(envelopeBytes - 1)).toEqual({ kind: 'refused', reason: 'resource-limit' })
})

it('exhausts exact retained sources larger than the outgoing allowance without a source-history cap', async () => {
  const f = await setup(
    Array.from(
      { length: 12 },
      (_, index) => `${index}: ${'Result 日本語🙂 "quoted"\n'.repeat(4096)}`
    )
  )
  const before = f.canonicalRows()
  const sourceBytes = before.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0)
  expect(sourceBytes).toBeGreaterThan(f.input.maxBytes)
  expect(Math.max(...before.map((row) => Buffer.byteLength(row)))).toBeLessThan(f.input.maxBytes)
  const hash = createHash('sha256')
  let count = 0
  let failure: unknown
  try {
    for await (const row of prepareConversationExactRows(f.input)) {
      expect(row.original.text).toBe(before[count])
      expect(row.representation.text).toBe(before[count])
      expect(row.original.version.sha256).toBe(
        createHash('sha256').update(before[count]).digest('hex')
      )
      hash.update(conversationEvidenceKey(row.original.version)).update('\n')
      count++
    }
  } catch (error) {
    failure = error
  } finally {
    expect(f.canonicalRows()).toEqual(before)
  }
  expect(
    failure,
    `retained=${sourceBytes}; produced=${count}/${f.snapshot.enumeration.sourceCount}`
  ).toBeUndefined()
  expect(count).toBe(f.snapshot.enumeration.sourceCount)
  expect(hash.digest('hex')).toBe(f.snapshot.enumeration.orderedVersionDigest)
  expect(
    f.fixture.host.db
      .prepare('SELECT COUNT(*) count FROM conversation_export_sources WHERE session_id=?')
      .get('session-a')?.count
  ).toBe(count)
})

it.each(['sensitive', 'lost-pin', 'cancelled'] as const)(
  'does not publish a successful source traversal after %s in the final retained row',
  async (scenario) => {
    const f = await setup([
      'Earlier nonmandatory result.',
      scenario === 'sensitive' ? `secret sk-proj-${'Z'.repeat(40)}` : 'Final exact result.'
    ])
    const controller = new AbortController()
    const consume = async () => {
      let seen = 0
      for await (const _row of prepareConversationExactRows({
        ...f.input,
        signal: controller.signal
      })) {
        if (++seen === 2) {
          if (scenario === 'cancelled') {
            controller.abort()
          }
          if (scenario === 'lost-pin') {
            f.fixture.host.db
              .prepare('DELETE FROM journal_epoch_pins WHERE owner_id=?')
              .run(f.snapshot.ownerId)
          }
        }
      }
      return seen
    }
    await expect(consume()).rejects.toThrow(
      scenario === 'sensitive'
        ? 'known-sensitive-source'
        : scenario === 'lost-pin'
          ? 'pin missing'
          : undefined
    )
    expect(
      f.fixture.host.db
        .prepare('SELECT COUNT(*) count FROM conversation_manifest_compilations')
        .get()?.count
    ).toBe(0)
  }
)
