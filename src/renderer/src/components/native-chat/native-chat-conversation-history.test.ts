import { expect, it } from 'vitest'
import type { ConversationHistoricalPage } from '../../../../shared/conversation-rpc'
import {
  projectConversationHistory,
  mergeConversationHistory
} from './native-chat-conversation-history'

type Entry = ConversationHistoricalPage['items'][number]
function entry(sessionId: string, segmentId: string, revision = 1): Entry {
  return {
    segmentId,
    provider: 'codex',
    originSource: { sessionId, epoch: 'epoch', sequence: 2 },
    revisionEpoch: 'epoch',
    item: {
      itemId: 'same-id',
      revision,
      sequence: 2,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'identical text' }] }
    }
  }
}
it('keeps identical text and provider IDs from distinct native sources, but replaces a source revision', () => {
  const a = entry('a', 'segment-a'),
    b = entry('b', 'segment-b')
  const merged = mergeConversationHistory([a, b], [entry('a', 'segment-a', 2)])
  expect(merged).toHaveLength(2)
  expect(merged[0].item.revision).toBe(2)
  const messages = projectConversationHistory(merged)
  expect(messages).toHaveLength(2)
  expect(messages[0].id).not.toBe(messages[1].id)
  expect(messages.map((m) => m.blocks)).toEqual([
    a.item.body.kind === 'message' ? a.item.body.blocks : [],
    b.item.body.kind === 'message' ? b.item.body.blocks : []
  ])
})
it('does not expose active-session full-output actions from another participant history', () => {
  const tool: Entry = {
    ...entry('a', 'segment-a'),
    item: {
      itemId: 'tool',
      revision: 1,
      sequence: 3,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        name: 'read',
        input: {},
        state: 'completed',
        output: { head: 'retained head', byteLength: 1000, digest: 'a'.repeat(64), truncated: true }
      }
    }
  }
  const messages = projectConversationHistory([tool])
  expect(messages[0].blocks.find((b) => b.type === 'tool-result')).not.toHaveProperty(
    'fullOutputItemId'
  )
  expect(messages[0].shortened).toBe(true)
})
it('never regresses a retained source to a late older revision', () => {
  expect(
    mergeConversationHistory([entry('a', 'segment-a', 3)], [entry('a', 'segment-a', 1)])[0].item
      .revision
  ).toBe(3)
})
