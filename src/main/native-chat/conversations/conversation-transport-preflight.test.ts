import { expect, it, vi } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { readConversationTransportSubmissionOriginal } from './conversation-transport-original'
import { conversationTriggerStateSchema } from './conversation-trigger-schema'

const source = { sessionId: 'session-a', epoch: 'epoch-session-a', sequence: 2 }
const preflight =
  "SELECT 1 FROM conversation_trigger_reservations WHERE target_session_id=? AND kind='trigger' LIMIT 1"

function reserve(
  f: Awaited<ReturnType<typeof createConversationSwitchFixture>>,
  input: { target: string; kind: 'trigger' | 'queued-continuation'; state: string }
) {
  f.host.db
    .prepare('INSERT INTO conversation_trigger_reservations VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      'test-transfer',
      input.kind,
      f.operationKey,
      'session-a',
      'queue-message',
      input.target,
      'target-message',
      '{}',
      input.state
    )
}

it.each(['none', 'other-target', 'queued-only'] as const)(
  'avoids whole-row JSON transport probing with %s reservations',
  async (variant) => {
    const f = await createConversationSwitchFixture('日本語🙂'.repeat(100_000))
    try {
      if (variant !== 'none') {
        reserve(f, {
          target: variant === 'other-target' ? 'session-b' : source.sessionId,
          kind: variant === 'queued-only' ? 'queued-continuation' : 'trigger',
          state: 'accepted'
        })
      }
      const prepare = vi.spyOn(f.host.db, 'prepare')
      try {
        expect(
          readConversationTransportSubmissionOriginal(
            f.host.db,
            f.records.conversations.intent(f.operationKey)!,
            source
          )
        ).toBeNull()
        expect(prepare.mock.calls.some(([sql]) => sql.includes('json_valid(j.row_json)'))).toBe(
          false
        )
        expect(prepare.mock.calls.some(([sql]) => sql === preflight)).toBe(true)
      } finally {
        prepare.mockRestore()
      }
    } finally {
      f.close()
    }
  }
)

it.each(conversationTriggerStateSchema.options)(
  'keeps the original identity probe for same-target trigger state %s',
  async (state) => {
    const f = await createConversationSwitchFixture('ordinary non-submission')
    try {
      reserve(f, { target: source.sessionId, kind: 'trigger', state })
      const prepare = vi.spyOn(f.host.db, 'prepare')
      try {
        expect(
          readConversationTransportSubmissionOriginal(
            f.host.db,
            f.records.conversations.intent(f.operationKey)!,
            source
          )
        ).toBeNull()
        expect(prepare.mock.calls.some(([sql]) => sql.includes('json_valid(j.row_json)'))).toBe(
          true
        )
      } finally {
        prepare.mockRestore()
      }
    } finally {
      f.close()
    }
  }
)

it('does not turn a matching corrupt transport proof into ordinary history', async () => {
  const f = await createConversationSwitchFixture()
  try {
    f.host.db
      .prepare('INSERT INTO journal_rows(session_id,epoch,seq,ts,row_json) VALUES(?,?,?,?,?)')
      .run(
        source.sessionId,
        source.epoch,
        source.sequence,
        2,
        JSON.stringify({ kind: 'submission', clientMessageId: 'target-message' })
      )
    reserve(f, { target: source.sessionId, kind: 'trigger', state: 'accepted' })
    expect(() =>
      readConversationTransportSubmissionOriginal(
        f.host.db,
        f.records.conversations.intent(f.operationKey)!,
        source
      )
    ).toThrow()
  } finally {
    f.close()
  }
})

it('uses the existing target-session index for the absence preflight', async () => {
  const f = await createConversationSwitchFixture()
  try {
    const plan = f.host.db.prepare(`EXPLAIN QUERY PLAN ${preflight}`).all(source.sessionId)
    expect(plan.some((row) => String(row.detail).includes('USING INDEX'))).toBe(true)
    expect(plan.some((row) => String(row.detail).includes('(target_session_id=?)'))).toBe(true)
  } finally {
    f.close()
  }
})
