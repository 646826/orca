import { expect, it } from 'vitest'
import {
  assertScratchMessageBound,
  CONVERSATION_SCRATCH_MESSAGE_BYTES,
  ConversationScratchCommandSchema
} from './conversation-scratch-protocol'

it('retains the existing isolated oversized projected row even with maximal JSON escaping', () => {
  const rowJson = JSON.stringify({ text: '\u0000'.repeat(Math.floor((1024 * 1024 - 20) / 6)) })
  const request = { command: 'append-replay', entries: [{ seq: 1, ts: 1, rowJson }] }
  expect(Buffer.byteLength(rowJson)).toBeGreaterThan(256 * 1024)
  expect(ConversationScratchCommandSchema.safeParse(request).success).toBe(true)
  expect(() => assertScratchMessageBound(request)).not.toThrow()
  const unicode = {
    ...request,
    entries: [{ seq: 1, ts: 1, rowJson: JSON.stringify({ text: '界'.repeat(1024 * 1024 - 20) }) }]
  }
  expect(() => assertScratchMessageBound(unicode)).not.toThrow()
})
it('rejects an oversized transport envelope instead of enqueueing its bytes', () => {
  expect(() =>
    assertScratchMessageBound({ value: 'x'.repeat(CONVERSATION_SCRATCH_MESSAGE_BYTES) })
  ).toThrow('resource limit')
})
it('rejects excess batch row admission and invalid page budgets before posting', () => {
  expect(
    ConversationScratchCommandSchema.safeParse({
      command: 'append-replay',
      entries: Array.from({ length: 17 }, (_, seq) => ({ seq, ts: 1, rowJson: '{}' }))
    }).success
  ).toBe(false)
  expect(
    ConversationScratchCommandSchema.safeParse({
      command: 'replay-page',
      after: null,
      limit: 257,
      maxBytes: 1024
    }).success
  ).toBe(false)
})
