import { afterEach, expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readConversationSegmentPage } from './conversation-segment-page'
let fixture: Awaited<ReturnType<typeof createConversationSwitchFixture>> | undefined
afterEach(() => fixture?.close())
it('returns bounded newest activated segments, excludes candidate and resumes older', async () => {
  const f = await createConversationSwitchFixture()
  fixture = f
  const intent = f.records.conversations.intent(f.operationKey)!
  const original = f.records.conversations
    .segments(intent.conversationId)
    .find((s) => s.sessionId === 'session-a')!
  for (let ordinal = 3; ordinal <= 6; ordinal++) {
    const segment = {
      ...original,
      ordinal,
      segmentId: `segment-${ordinal}`,
      lifecycle: 'activated' as const
    }
    f.host.db
      .prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)')
      .run(segment.segmentId, intent.conversationId, ordinal, JSON.stringify(segment))
  }
  const first = readConversationSegmentPage(f.host.db, intent.conversationId, null, 2)
  expect(first.segments.map((s) => s.ordinal)).toEqual([6, 5])
  expect(first.nextSegmentOrdinal).toBe(5)
  expect(
    readConversationSegmentPage(
      f.host.db,
      intent.conversationId,
      first.nextSegmentOrdinal,
      2
    ).segments.map((s) => s.ordinal)
  ).toEqual([4, 3])
  const last = readConversationSegmentPage(f.host.db, intent.conversationId, 3, 2)
  expect(last.segments.map((s) => s.ordinal)).toEqual([1])
  expect(last.nextSegmentOrdinal).toBeNull()
})
it('refuses corrupt segment ordinal metadata rather than issuing a false cursor', async () => {
  const f = await createConversationSwitchFixture()
  fixture = f
  const intent = f.records.conversations.intent(f.operationKey)!
  f.host.db
    .prepare(
      "UPDATE conversation_segments SET record_json=json_set(record_json,'$.ordinal',99) WHERE conversation_id=? AND ordinal=1"
    )
    .run(intent.conversationId)
  expect(() => readConversationSegmentPage(f.host.db, intent.conversationId, null, 2)).toThrow(
    'corrupt-record'
  )
})
