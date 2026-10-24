import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session-context-clear'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  applyJournalRow,
  journalEchoClaimant,
  createJournalReducerState,
  renderJournalState
} from '../agent-session-journal/journal-reducer'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { ConversationReducerDiskItems } from './conversation-reducer-disk-map'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose()
  }
})
function disk() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reducer-map-'))
  const db = new Database(join(dir, 'projection.sqlite'))
  cleanup.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return new ConversationReducerDiskItems(db)
}
function item(id: string): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
  }
}
describe('temporary reducer item map', () => {
  it('preserves insertion order, replacement and live deletion/reinsertion iteration', () => {
    const map = disk()
    map.set('a', item('a')).set('b', item('b'))
    const cursor = map.entries()
    expect(cursor.next().value).toEqual(['a', item('a')])
    map.delete('b')
    map.set('c', item('c')).set('a', item('revised')).set('b', item('again'))
    expect([...cursor]).toEqual([
      ['c', item('c')],
      ['b', item('again')]
    ])
    expect([...map.keys()]).toEqual(['a', 'c', 'b'])
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(true)
    map.clear()
    expect([...map]).toEqual([])
    expect(map.size).toBe(0)
  })
  it('pages canonical position order after handover moves an existing item', () => {
    const map = disk()
    map.set('first', { ...item('first'), sequence: 1 })
    map.set('second', { ...item('second'), sequence: 2 })
    map.set('first', { ...item('first'), sequence: 3 })
    const first = map.page(null, 1)
    expect(first.items.map((value) => value.itemId)).toEqual(['second'])
    expect(map.page(first.next, 1).items.map((value) => value.itemId)).toEqual(['first'])
    expect(() => map.page(null, 1000)).toThrow()
    expect(() => map.page(null, 1, 1)).toThrow(
      expect.objectContaining({ reason: 'resource-limit' })
    )
  })
  it('folds revisions, tombstones, provider echo and dispatch exactly as the existing reducer', () => {
    const memory = createJournalReducerState('session', 'epoch')
    const spilled = createJournalReducerState('session', 'epoch')
    spilled.items = disk()
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }]
    } as const
    const base = (seq: number) => ({ v: 1, epoch: 'epoch', seq, ts: seq, fence: 1 })
    const rows: JournalRow[] = [
      {
        ...base(1),
        kind: 'submission',
        clientMessageId: 'send',
        payloadFingerprint: 'fingerprint',
        providerHandle: { kind: 'codex', threadId: 'thread' },
        body: { ...body, blocks: [...body.blocks] }
      },
      {
        ...base(2),
        kind: 'dispatch',
        clientMessageId: 'send',
        state: 'accepted',
        providerItemId: 'provider',
        reason: null
      },
      {
        ...base(3),
        kind: 'item',
        itemId: 'provider',
        revision: 1,
        body: { ...body, blocks: [...body.blocks] },
        echoOf: 'send'
      },
      {
        ...base(4),
        kind: 'item',
        itemId: 'answer',
        revision: 1,
        body: item('first').body,
        agentId: 'worker',
        turnScope: { kind: 'turn', turnItemId: 'turn' }
      },
      { ...base(5), kind: 'item', itemId: 'answer', revision: 2, body: item('second').body },
      { ...base(6), kind: 'tombstone', itemId: 'answer', revision: 3 },
      { ...base(7), kind: 'item', itemId: 'answer', revision: 4, body: item('returned').body },
      { ...base(8), kind: 'item', itemId: 'answer', revision: 2, body: item('stale').body },
      {
        ...base(9),
        kind: 'submission',
        clientMessageId: 'queued',
        payloadFingerprint: 'queued-fingerprint',
        providerHandle: { kind: 'codex', threadId: 'thread' },
        handoverRecorded: true,
        body: { ...body, blocks: [...body.blocks] }
      },
      {
        ...base(10),
        kind: 'item',
        itemId: 'before-handover',
        revision: 1,
        body: item('intervening').body
      },
      {
        ...base(11),
        kind: 'dispatch',
        clientMessageId: 'queued',
        state: 'pending',
        providerItemId: null,
        reason: null,
        turnScope: { kind: 'turn', turnItemId: 'turn' }
      }
    ]
    for (const row of rows) {
      applyJournalRow(memory, row)
      applyJournalRow(spilled, row)
      expect(renderJournalState(spilled)).toEqual(renderJournalState(memory))
      expect([...spilled.items]).toEqual([...memory.items])
    }
  })
})

it('uses the indexed clear query for real provider echoes and matches clear revision/tombstone semantics', () => {
  const memory = createJournalReducerState('session', 'epoch')
  const spilled = createJournalReducerState('session', 'epoch')
  const map = disk()
  spilled.items = map
  spilled.replayQueries = { latestContextClearSequence: () => map.latestContextClearSequence() }
  const scan = vi.spyOn(map, 'values').mockImplementation(() => {
    throw new Error('unexpected full item scan')
  })
  const providerId = agentJournalItemKey({
    provider: 'codex',
    threadId: 'thread',
    turnId: 'turn',
    ordinal: 0
  })
  const body = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'repeat' }]
  } as const
  const message = { ...body, blocks: [...body.blocks] }
  const base = (seq: number) => ({ v: 1, epoch: 'epoch', seq, ts: seq, fence: 1 })
  const clear = {
    kind: 'status',
    text: 'clear',
    contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
  } as const
  const rows: JournalRow[] = [
    {
      ...base(1),
      kind: 'submission',
      clientMessageId: 'first',
      payloadFingerprint: agentSessionSendBodyFingerprint('session', message),
      providerHandle: { kind: 'codex', threadId: 'thread' },
      body: message,
      handoverRecorded: true
    },
    { ...base(2), kind: 'item', itemId: 'clear', revision: 1, body: clear },
    {
      ...base(3),
      kind: 'item',
      itemId: 'clear',
      revision: 2,
      body: { kind: 'status', text: 'revised away' }
    },
    { ...base(4), kind: 'tombstone', itemId: 'clear', revision: 3 },
    { ...base(5), kind: 'item', itemId: 'clear', revision: 4, body: clear },
    {
      ...base(6),
      kind: 'submission',
      clientMessageId: 'second',
      payloadFingerprint: agentSessionSendBodyFingerprint('session', message),
      providerHandle: { kind: 'codex', threadId: 'thread' },
      body: message,
      handoverRecorded: true
    },
    {
      ...base(7),
      kind: 'item',
      itemId: 'clear',
      revision: 5,
      body: { kind: 'status', text: 'revised away again' }
    }
  ]
  const claimants: (string | null)[] = []
  for (const row of rows) {
    applyJournalRow(memory, row)
    applyJournalRow(spilled, row)
    expect(map.latestContextClearSequence()).toBe(
      latestAgentSessionContextClearSequence(memory.items.values())
    )
    const expected = journalEchoClaimant(memory, providerId, message)
    expect(journalEchoClaimant(spilled, providerId, message)).toBe(expected)
    claimants.push(expected)
  }
  expect(claimants).toEqual([
    'orca:first',
    null,
    'orca:first',
    'orca:first',
    null,
    'orca:second',
    'orca:first'
  ])
  expect(scan).not.toHaveBeenCalled()
  scan.mockRestore()
})
