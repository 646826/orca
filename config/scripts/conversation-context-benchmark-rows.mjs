import { agentJournalItemKey } from '../../src/shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../src/shared/structured-agent-session-send-mutation'

/** Ten events per cycle include real provider echoes, admission and revisions. */
export function* conversationBenchmarkRows(eventCount, schemaVersion) {
  if (!Number.isSafeInteger(eventCount) || eventCount < 10 || eventCount % 10 !== 0) {
    throw new RangeError('Mixed journal fixture requires a positive multiple of ten events')
  }
  const base = (seq) => ({ v: schemaVersion, epoch: 'synthetic', seq, ts: seq, fence: 1 })
  const providerHandle = { kind: 'codex', threadId: 'synthetic' }
  yield { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }
  const text = 'Synthetic 日本語🙂 code const value = 1; '.repeat(20)
  for (let cycle = 0; cycle < eventCount / 10; cycle++) {
    const key = (ordinal) =>
      agentJournalItemKey({
        provider: 'codex',
        threadId: 'synthetic',
        turnId: `turn-${cycle}`,
        ordinal
      })
    const message = (role, suffix) => ({
      kind: 'message',
      role,
      blocks: [{ type: 'text', text: `${cycle}:${suffix}: ${text}` }]
    })
    const body = message('user', 'submitted')
    const clientMessageId = `send-${cycle}`
    const item = (ordinal, revision, body) => ({
      kind: 'item',
      itemId: key(ordinal),
      revision,
      body
    })
    const tool = (state) => ({ kind: 'tool-call', name: 'Read', state, input: `${cycle}: ${text}` })
    const events = [
      {
        kind: 'submission',
        clientMessageId,
        providerHandle,
        payloadFingerprint: agentSessionSendBodyFingerprint('synthetic-session', body),
        origin: 'client',
        body
      },
      { kind: 'dispatch', clientMessageId, state: 'pending', providerItemId: null, reason: null },
      item(0, 1, body),
      {
        kind: 'dispatch',
        clientMessageId,
        state: 'accepted',
        providerItemId: key(0),
        reason: null
      },
      item(1, 1, message('assistant', 'draft')),
      item(2, 1, tool('running')),
      item(2, 2, tool('done')),
      item(1, 2, message('assistant', 'revised')),
      item(3, 1, message('user', 'unmatched-provider-history')),
      item(4, 1, message('assistant', 'final'))
    ]
    for (const [index, event] of events.entries()) {
      yield { ...base(cycle * 10 + index + 2), ...event }
    }
  }
}
