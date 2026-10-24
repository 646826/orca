import { expect, it } from 'vitest'
import { CALLER } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import { createCodexConversationRoundtripFixture } from './structured-conversation-roundtrip.test-fixture'
import { readConversationManifest } from '../conversations/conversation-context-coverage'

it('returns from an admitted envelope whose generated JSON escaping exceeds the ordinary row bound', async () => {
  const f = await createCodexConversationRoundtripFixture()
  try {
    await f.enrollSource()
    const source = f.send(HOST_TEST_SESSION, 'Retain the source decisions precisely.')
    await f.acceptNative(HOST_TEST_SESSION, [
      `Decision one: ${'"'.repeat(60_000)}`,
      `Decision two: ${'"'.repeat(60_000)}`,
      `Decision three: ${'"'.repeat(60_000)}`
    ])
    expect(await source).toMatchObject({ ok: true })
    const intent = await f.foundTarget(HOST_TEST_SESSION, f.targetId, {
      options: { model: 'gpt-live' }
    })
    await expect(f.host.advanceConversationSwitch(intent.operationKey, f.signal)).rejects.toThrow(
      'Candidate native acquisition refused'
    )
    const trust = f.host.deps.conversationEvidenceTrust!.read(intent.operationKey)!
    f.host.deps.conversationEvidenceTrust!.approve(
      { operationKey: intent.operationKey, choiceDigest: trust.choiceDigest },
      CALLER.callerKey
    )
    expect(await f.host.advanceConversationSwitch(intent.operationKey, f.signal)).toMatchObject({
      kind: 'blocked'
    })
    const trigger = 'Original small trigger with 日本語🙂.'
    expect(await f.send(HOST_TEST_SESSION, trigger, true)).toMatchObject({ ok: true })
    f.approve(f.state.store.conversations.intent(intent.operationKey)!)
    expect(await f.host.advanceConversationSwitch(intent.operationKey, f.signal)).toEqual({
      kind: 'waiting-consent'
    })
    f.consent(intent)
    const outward = f.host.advanceConversationSwitch(intent.operationKey, f.signal)
    await f.acceptNative(f.targetId, 'Target decision received.')
    expect(await outward).toMatchObject({ kind: 'activated' })
    const saved = f.db
      .prepare(
        "SELECT row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='submission'"
      )
      .get(f.targetId)?.row_json
    if (typeof saved !== 'string') {
      throw new Error('canonical target submission missing')
    }
    expect(Buffer.byteLength(saved)).toBeGreaterThan(1024 * 1024)
    const wrapped = JSON.parse(saved)
    expect(Buffer.byteLength(wrapped.body.blocks[0].text)).toBeLessThanOrEqual(1024 * 1024)
    const back = await f.beginReturn(f.targetId, HOST_TEST_SESSION)
    expect(await f.send(f.targetId, 'Return the exact original trigger.', true)).toMatchObject({
      ok: true
    })
    f.approve(back)
    expect(await f.host.advanceConversationSwitch(back.operationKey, f.signal)).toEqual({
      kind: 'waiting-consent'
    })
    f.consent(back)
    const returning = f.host.advanceConversationSwitch(back.operationKey, f.signal)
    await f.acceptNative(HOST_TEST_SESSION, 'Returned with original trigger.')
    expect(await returning).toMatchObject({ kind: 'activated' })
    const manifest = readConversationManifest(
      f.db,
      f.state.store.conversations.intent(back.operationKey)!.manifestId!
    )!
    const part = manifest.projection.find(
      (p) => p.representation === 'transport-projected' && JSON.parse(p.text!).kind === 'submission'
    )!
    expect(JSON.parse(part.text!).body.blocks).toEqual(hostTestMessage(trigger).blocks)
    expect(Buffer.byteLength(part.text!)).toBeLessThanOrEqual(1024 * 1024)
    expect(
      f.db
        .prepare(
          "SELECT row_json FROM journal_rows WHERE session_id=? AND json_extract(row_json,'$.kind')='submission'"
        )
        .get(f.targetId)?.row_json
    ).toBe(saved)
  } finally {
    await f.close()
  }
}, 90_000)
