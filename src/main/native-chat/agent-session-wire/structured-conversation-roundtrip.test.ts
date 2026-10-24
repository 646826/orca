import { expect, it } from 'vitest'
import { CALLER } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import { readConversationManifest } from '../conversations/conversation-context-coverage'
import { createCodexConversationRoundtripFixture } from './structured-conversation-roundtrip.test-fixture'

it.each(['configured', 'default'] as const)(
  'uses production preparation and native delivery for %s model A → B → A',
  async (modelChoice) => {
    const {
      state,
      host,
      db,
      signal,
      targetId,
      codex,
      send,
      acceptNative,
      approve,
      consent,
      enrollSource,
      foundTarget,
      beginReturn,
      close
    } = await createCodexConversationRoundtripFixture()
    try {
      await enrollSource()
      const initial = send(HOST_TEST_SESSION, 'Original decision: preserve 日本語🙂 and all files.')
      await acceptNative(HOST_TEST_SESSION, 'A native response: original decision retained.')
      expect(await initial).toMatchObject({ ok: true })
      const intent = await foundTarget(
        HOST_TEST_SESSION,
        targetId,
        modelChoice === 'configured' ? { options: { model: 'gpt-live' } } : {}
      )
      await expect(host.advanceConversationSwitch(intent.operationKey, signal)).rejects.toThrow(
        'Candidate native acquisition refused'
      )
      const trust = host.deps.conversationEvidenceTrust!.read(intent.operationKey)!
      expect(trust).not.toBeNull()
      host.deps.conversationEvidenceTrust!.approve(
        { operationKey: intent.operationKey, choiceDigest: trust.choiceDigest },
        CALLER.callerKey
      )
      expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toMatchObject({
        kind: 'blocked',
        reasons: ['recipient-approval-required']
      })
      expect(
        await send(
          HOST_TEST_SESSION,
          'First switch trigger; historicalEvidence is literal user text.',
          true
        )
      ).toMatchObject({ ok: true })
      if (modelChoice === 'default') {
        expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toMatchObject({
          kind: 'blocked'
        })
        expect(host.deps.conversationPreparationControls!.read(intent.operationKey)).toMatchObject({
          status: 'target-unavailable',
          target: null
        })
        expect(host.collaboratorsForTests().sessions.get(targetId)!.journal.submissions()).toEqual(
          []
        )
        expect(
          host
            .collaboratorsForTests()
            .sessions.get(HOST_TEST_SESSION)!
            .journal.queuedMessages.list()[0]?.state
        ).toBe('waiting')
        expect(
          codex.connections.flatMap((c) => c.calls.filter((call) => call.method === 'turn/start'))
        ).toHaveLength(1)
        return
      }
      approve(state.store.conversations.intent(intent.operationKey)!)
      expect(await host.advanceConversationSwitch(intent.operationKey, signal)).toEqual({
        kind: 'waiting-consent'
      })
      consent(intent)
      const outward = host.advanceConversationSwitch(intent.operationKey, signal)
      const firstWire = await acceptNative(
        targetId,
        'B native response: preserve original decision.'
      )
      expect(await outward).toMatchObject({ kind: 'activated' })
      expect(JSON.stringify(firstWire)).toContain(
        'Original decision: preserve 日本語🙂 and all files.'
      )
      const returning = await beginReturn(targetId, HOST_TEST_SESSION)
      expect(
        await send(targetId, 'Return trigger: keep all earlier decisions.', true)
      ).toMatchObject({ ok: true })
      approve(returning)
      expect(await host.advanceConversationSwitch(returning.operationKey, signal)).toEqual({
        kind: 'waiting-consent'
      })
      consent(returning)
      const inbound = host.advanceConversationSwitch(returning.operationKey, signal)
      const returnWire = await acceptNative(HOST_TEST_SESSION, 'A resumed native response.')
      expect(await inbound).toMatchObject({ kind: 'activated' })
      expect(JSON.stringify(returnWire)).toContain('B native response: preserve original decision.')
      const backIntent = state.store.conversations.intent(returning.operationKey)!
      const manifest = readConversationManifest(db, backIntent.manifestId!)!
      const transferred = manifest.projection.filter(
        (part) => part.representation === 'transport-projected'
      )
      expect(transferred.length).toBeGreaterThan(0)
      for (const part of transferred) {
        const row = JSON.parse(part.text!)
        if (row.kind === 'submission') {
          expect(row.body.blocks).toEqual(
            hostTestMessage('First switch trigger; historicalEvidence is literal user text.').blocks
          )
        }
      }
      const afterReturn = send(HOST_TEST_SESSION, 'Ordinary send after return.')
      await acceptNative(HOST_TEST_SESSION, 'Ordinary response after return.')
      expect(await afterReturn).toMatchObject({ ok: true })
      expect(
        db.prepare('SELECT 1 FROM conversation_origin_rows WHERE origin_json IS NULL').get()
      ).toBeUndefined()
      expect(codex.connections).toHaveLength(2)
      expect(
        codex.connections.flatMap((c) => c.calls.filter((call) => call.method === 'turn/start'))
      ).toHaveLength(4)
      expect(
        host
          .collaboratorsForTests()
          .sessions.get(targetId)!
          .journal.submissions()
          .map((s) => s.dispatchState)
      ).toEqual(['accepted'])
      expect(
        codex.connections[0]!.calls.filter((call) => call.method === 'thread/start')
      ).toHaveLength(1)
      expect(
        codex.connections[1]!.calls.filter((call) => call.method === 'thread/start')
      ).toHaveLength(1)
      expect(host.deps.adapter.contextDeliveryCapabilities?.(HOST_TEST_SESSION)).toMatchObject({
        state: 'verified'
      })
    } finally {
      await close()
    }
  }
)
