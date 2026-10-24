import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { ConversationHistoryIndex } from './conversation-history-index'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
test('history display page reserves byte space for source attribution and cursor envelope', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-history-budget-'))
  roots.push(root)
  const index = new ConversationHistoryIndex(root)
  try {
    index.beginEpoch()
    for (let sequence = 1; sequence <= 3; sequence++) {
      index.append(
        {
          itemId: `item-${sequence}`,
          sequence,
          revision: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'x'.repeat(200) }]
          }
        },
        'segment',
        'epoch'
      )
    }
    const input = {
      segmentId: 'segment',
      sessionId: 'session',
      provider: 'codex',
      sourceRevision: 'r'.repeat(64),
      after: null,
      limit: 128,
      byteLimit: 1024
    }
    const first = index.page(input)
    expect(first.status).toBe('more')
    expect(first.items).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1024)
    const next = index.page({ ...input, after: first.next })
    expect(next.items[0]?.item.itemId).toBe('item-2')
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(1024)
  } finally {
    index.close()
  }
  expect(readdirSync(root)).toEqual([])
})
test('backward pages expose latest tail in chronological order and traverse older without duplicates', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-history-backward-'))
  roots.push(root)
  const index = new ConversationHistoryIndex(root)
  try {
    index.beginEpoch()
    for (let sequence = 1; sequence <= 5; sequence++) {
      index.append(
        {
          itemId: `item-${sequence}`,
          sequence,
          revision: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: String(sequence) }]
          }
        },
        'segment',
        'epoch'
      )
    }
    const input = {
      segmentId: 'segment',
      sessionId: 'session',
      provider: 'codex',
      sourceRevision: 'r',
      after: null,
      limit: 2,
      byteLimit: 8192,
      direction: 'backward' as const
    }
    const tail = index.page(input)
    expect(tail.items.map((i) => i.item.itemId)).toEqual(['item-4', 'item-5'])
    const older = index.page({ ...input, after: tail.next })
    expect(older.items.map((i) => i.item.itemId)).toEqual(['item-2', 'item-3'])
    const first = index.page({ ...input, after: older.next })
    expect(first.items.map((i) => i.item.itemId)).toEqual(['item-1'])
    expect(first.next).toBeNull()
  } finally {
    index.close()
  }
})
