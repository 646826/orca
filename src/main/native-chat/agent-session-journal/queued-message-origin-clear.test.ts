import { expect, it } from 'vitest'
import { createConversationSwitchFixture } from '../conversations/conversation-switch.fixture'
import { createConversationOriginRowHook } from '../conversations/conversation-origin-rows'
import { AgentSessionJournal } from './journal-store'
import { appendConversationClearJournals } from '../conversations/conversation-clear-journals'

it('holds original drafts through an actual aggregate clear receipt and admits only newly captured drafts', async () => {
  const f = await createConversationSwitchFixture()
  try {
    const pending = f.records.conversations.intent(f.operationKey)!
    const before = f.records.conversations.read(pending.conversationId)!
    await f.records.conversations.cancel({
      operationKey: f.operationKey,
      expectedVersion: pending.version,
      expectedRevision: before.revision,
      expectedContextGeneration: before.contextGeneration,
      expectedActivationFence: before.activationFence
    })
    const conversation = f.records.conversations.read(before.conversationId)!
    const started = await f.records.conversations.clear.begin(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence
      },
      {
        callerKey: 'caller',
        operationId: `1800000000000-${'c'.repeat(32)}`,
        fingerprint: 'clear',
        now: 1800000000000
      }
    )
    const intent = started.intent!
    const journals = await Promise.all(
      ['session-a', 'session-b'].map(async (sessionId) => {
        const journal = new AgentSessionJournal({
          database: f.host,
          requiredInTransaction: createConversationOriginRowHook(sessionId),
          identity: {
            sessionId,
            workspaceId: 'folder',
            hostId: 'local',
            agent: 'codex',
            providerHandle: null
          },
          now: () => 1800000000001
        })
        await journal.open()
        return journal
      })
    )
    const journal = journals[0]!
    const queue = (messageId: string) =>
      journal.queuedMessages.insert({
        messageId,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: messageId }] }
      })
    await queue('old')
    const prepared = await f.records.conversations.clear.prepare({
      operationKey: intent.operationKey,
      expectedVersion: intent.version
    })
    await appendConversationClearJournals({
      journals,
      clear: f.records.conversations.clear,
      activeSessionId: 'session-a',
      operationKey: prepared.operationKey,
      expectedVersion: prepared.version,
      now: 1800000000001,
      isCurrent: (current) => journals.includes(current)
    })
    expect(journal.queuedMessages.get('old')).toMatchObject({
      state: 'waiting',
      holdReason: 'context_generation_changed'
    })
    await queue('new')
    const consume = (messageId: string) => {
      const card = journal.queuedMessages.get(messageId)!
      return journal.appendSubmission(
        {
          clientMessageId: `send-${messageId}`,
          payloadFingerprint: card.fingerprint,
          body: card.body,
          fence: 1
        },
        { messageId, expect: 'waiting' }
      )
    }
    await expect(consume('old')).rejects.toThrow('stale-generation')
    await consume('new')
    expect(journal.queuedMessages.get('new')?.state).toBe('dispatched')
    await Promise.all(journals.map((entry) => entry.close()))
    expect(f.records.conversations.membership('session-b')?.contextGeneration).toBe(2)
  } finally {
    f.close()
  }
})
