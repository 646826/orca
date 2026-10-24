import { attributeConversationSourceBoundary } from './conversation-source-attribution'
import { afterEach, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  freezeConversationPreparationSources,
  readConversationPreparationSources
} from './conversation-preparation-sources'
import { conversationEvidenceKey } from './conversation-context-evidence'

const fixtures: Awaited<ReturnType<typeof createConversationSwitchFixture>>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close()
  }
})

test('enumerates the entire frozen host source prefix, not a caller selected page or candidate', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  f.append('session-a', 2)
  const segment = JSON.parse(
    String(
      f.host.db.prepare('SELECT record_json FROM conversation_segments WHERE ordinal=1').get()
        ?.record_json
    )
  )
  f.host.transaction((db) =>
    attributeConversationSourceBoundary(db, segment.segmentId, 'session-a', 1, {
      sessionId: 'session-a',
      epoch: 'epoch-session-a',
      endSequence: 2
    })
  )
  const intent = f.records.conversations.intent(f.operationKey)!
  const frozen = await freezeConversationPreparationSources(
    f.host.db,
    intent,
    new AbortController().signal
  )
  const hash = createHash('sha256')
  for (const row of f.host.db
    .prepare('SELECT seq,row_json FROM journal_rows WHERE session_id=? ORDER BY seq')
    .all('session-a')) {
    hash
      .update(
        conversationEvidenceKey({
          source: { sessionId: 'session-a', epoch: 'epoch-session-a', sequence: Number(row.seq) },
          sha256: createHash('sha256').update(String(row.row_json)).digest('hex')
        })
      )
      .update('\n')
  }
  expect(frozen.enumeration).toEqual({ sourceCount: 2, orderedVersionDigest: hash.digest('hex') })
  expect(frozen.boundaries).toEqual([
    { sessionId: 'session-a', epoch: 'epoch-session-a', endSequence: 2 }
  ])
  expect(() =>
    f.host.db.prepare('DELETE FROM journal_rows WHERE session_id=?').run('session-a')
  ).toThrow()
})

test('source changes while yielding invalidate the snapshot rather than silently omit the late row', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const intent = f.records.conversations.intent(f.operationKey)!
  const operation = freezeConversationPreparationSources(
    f.host.db,
    intent,
    new AbortController().signal
  )
  f.append('session-a', 2)
  await expect(operation).rejects.toThrow('Preparation source changed')
})

test('cancelled preparation does not retain its temporary pins', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  const controller = new AbortController()
  const operation = freezeConversationPreparationSources(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!,
    controller.signal
  )
  controller.abort()
  await expect(operation).rejects.toThrow()
  expect(
    f.host.db
      .prepare(
        "SELECT count(*) AS n FROM journal_epoch_pins WHERE owner_id LIKE 'conversation-preparation:%'"
      )
      .get()?.n
  ).toBe(0)
})

test('rejects unclassified source rows rather than assuming the active segment', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  f.append('session-a', 2)
  await expect(
    freezeConversationPreparationSources(
      f.host.db,
      f.records.conversations.intent(f.operationKey)!,
      new AbortController().signal
    )
  ).rejects.toThrow('origin unknown')
})
test('retains the prefix but excludes old-generation attributed rows from delivery enumeration', async () => {
  const f = await createConversationSwitchFixture()
  fixtures.push(f)
  f.append('session-a', 2)
  const first = JSON.parse(
    String(
      f.host.db.prepare('SELECT record_json FROM conversation_segments WHERE ordinal=1').get()
        ?.record_json
    )
  )
  const prior = { ...first, segmentId: 'old-generation', ordinal: 3, contextGeneration: 2 }
  f.host.db
    .prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)')
    .run(prior.segmentId, prior.conversationId, 3, JSON.stringify(prior))
  f.host.db
    .prepare('INSERT INTO conversation_source_attribution VALUES(?,?,?,?)')
    .run('session-a', 'epoch-session-a', 2, prior.segmentId)
  const frozen = await freezeConversationPreparationSources(
    f.host.db,
    f.records.conversations.intent(f.operationKey)!,
    new AbortController().signal
  )
  expect(frozen.enumeration.sourceCount).toBe(1)
  expect(frozen.boundaries[0]?.endSequence).toBe(2)
  f.host.db
    .prepare(
      "UPDATE conversation_segments SET record_json=json_set(record_json,'$.contextGeneration',1) WHERE segment_id=?"
    )
    .run(prior.segmentId)
  expect(() => readConversationPreparationSources(f.host.db, frozen.ownerId)).toThrow(
    'provenance changed'
  )
})
