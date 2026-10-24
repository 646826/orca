import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createQueuedMessageTestRig } from '../agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION } from '../agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionAdapter } from '../agent-session-wire/structured-agent-session-adapter'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import {
  canonicalUserTextBlocks,
  conversationRepresentationRequiresInline
} from './conversation-context-constraints'

it('retains a real automatically drained user submission without requiring a provider echo', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    const first = rig.send('work before the queued instruction')
    expect(await first.result).toMatchObject({ ok: true })
    await rig.host.waitForSendSettlement(HOST_TEST_SESSION, first.id, {
      until: 'handed-over',
      budgetMs: 5_000
    })
    const instruction = 'Never upload the private workspace. Preserve 日本語🙂.'
    const queued = await rig.send(instruction, 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('Expected a real queued user draft')
    }
    const handoff =
      Promise.withResolvers<Parameters<StructuredAgentSessionAdapter['dispatch']>[0]>()
    rig.dispatch.mockImplementationOnce(async (input) => {
      handoff.resolve(input)
      return { state: 'admitted' }
    })
    await rig.settleAccepted(first.id, 'first')
    const delivered = await handoff.promise
    await rig.settleAccepted(delivered.clientMessageId, 'queued')
    expect(await rig.handoff(queued.value.queued.messageId)).toMatchObject({
      origin: 'host',
      dispatchState: 'accepted'
    })
    const db = rig.host.deps.journalDatabase.db
    const stored = db
      .prepare(
        "SELECT row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='submission' AND json_extract(row_json,'$.clientMessageId')=?"
      )
      .get(HOST_TEST_SESSION, delivered.clientMessageId)
    if (typeof stored?.row_json !== 'string') {
      throw new Error('Canonical queue submission missing')
    }
    const parsed = parseJournalRow(stored.row_json)
    if (!parsed.ok || parsed.row.kind !== 'submission') {
      throw new Error('Canonical queue submission invalid')
    }
    expect(parsed.row).toMatchObject({
      origin: 'host',
      queuedMessageId: queued.value.queued.messageId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: instruction }] }
    })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind') IN ('item','lifecycle-batch')"
        )
        .get(HOST_TEST_SESSION)?.count
    ).toBe(0)
    expect(canonicalUserTextBlocks(stored.row_json)).toEqual([])
    expect(
      conversationRepresentationRequiresInline(
        { mandatory: [] },
        {
          version: {
            source: {
              sessionId: HOST_TEST_SESSION,
              epoch: parsed.row.epoch,
              sequence: parsed.row.seq
            },
            sha256: createHash('sha256').update(stored.row_json).digest('hex')
          },
          representation: 'exact',
          text: stored.row_json,
          spans: []
        }
      )
    ).toBe(true)
  } finally {
    await rig.dispose()
  }
})
