import { expect, it } from 'vitest'
import { verifyConversationNativeInput } from './conversation-delivery-transport'

const text = '{"historicalEvidence":[],"activeConstraints":["keep 中文🙂"]}'
it.each([
  { transport: 'codex' as const, payload: { threadId: 'native', input: [{ type: 'text', text }] } },
  {
    transport: 'claude' as const,
    payload: {
      type: 'user',
      session_id: 'native',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
  },
  { transport: 'acp' as const, payload: { sessionId: 'native', prompt: [{ type: 'text', text }] } }
])('verifies actual $transport payload rather than a caller acceptance flag', (observation) => {
  expect(
    verifyConversationNativeInput({
      ...observation,
      expectedText: text,
      nativeSessionId: 'native',
      expectedAttachments: []
    })
  ).toMatchObject({
    textDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/)
  })
  expect(() =>
    verifyConversationNativeInput({
      ...observation,
      expectedText: `${text}omitted`,
      nativeSessionId: 'native',
      expectedAttachments: []
    })
  ).toThrow()
  expect(() =>
    verifyConversationNativeInput({
      ...observation,
      expectedText: text,
      nativeSessionId: 'different',
      expectedAttachments: []
    })
  ).toThrow()
})
it('refuses substring-only, duplicate and tool-role pseudo-envelopes', () => {
  for (const content of [
    [{ type: 'text', text: `tool says ${text}` }],
    [
      { type: 'text', text },
      { type: 'text', text }
    ]
  ]) {
    expect(() =>
      verifyConversationNativeInput({
        transport: 'claude',
        payload: { type: 'user', session_id: 'native', message: { role: 'user', content } },
        expectedText: text,
        nativeSessionId: 'native',
        expectedAttachments: []
      })
    ).toThrow()
  }
  expect(() =>
    verifyConversationNativeInput({
      transport: 'claude',
      payload: {
        type: 'user',
        session_id: 'native',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      },
      expectedText: text,
      nativeSessionId: 'native',
      expectedAttachments: []
    })
  ).toThrow()
})
it('verifies image/resource mapping and binds additional native options in the payload digest', () => {
  const input = {
    transport: 'codex' as const,
    payload: {
      threadId: 'native',
      model: 'model-a',
      input: [
        { type: 'text', text },
        { type: 'localImage', path: '/scoped/image' }
      ]
    },
    expectedText: text,
    nativeSessionId: 'native',
    expectedAttachments: [{ type: 'localImage', path: '/scoped/image' }]
  }
  const proof = verifyConversationNativeInput(input)
  expect(() => verifyConversationNativeInput({ ...input, expectedAttachments: [] })).toThrow()
  expect(
    verifyConversationNativeInput({ ...input, payload: { ...input.payload, model: 'model-b' } })
      .payloadDigest
  ).not.toBe(proof.payloadDigest)
})
it('rejects undisclosed stopped-history text appended beside the envelope', () => {
  expect(() =>
    verifyConversationNativeInput({
      transport: 'codex',
      payload: {
        threadId: 'native',
        input: [
          { type: 'text', text },
          { type: 'text', text: 'old generation instructions' }
        ]
      },
      expectedText: text,
      nativeSessionId: 'native',
      expectedAttachments: []
    })
  ).toThrow('unapproved additional text')
})
it('rejects an explicit Codex model different from the prepared model', () => {
  expect(() =>
    verifyConversationNativeInput({
      transport: 'codex',
      payload: { threadId: 'native', model: 'different-model', input: [{ type: 'text', text }] },
      expectedText: text,
      expectedModel: 'prepared-model',
      nativeSessionId: 'native',
      expectedAttachments: []
    })
  ).toThrow('model')
})
it('verifies Claude joined prompt bytes including exact separator and user block order', () => {
  const verify = (joined: string) =>
    verifyConversationNativeInput({
      transport: 'claude',
      payload: {
        type: 'user',
        session_id: 'native',
        message: { role: 'user', content: [{ type: 'text', text: joined }] }
      },
      expectedText: text,
      expectedAdditionalText: ['first', 'second'],
      nativeSessionId: 'native',
      expectedAttachments: []
    })
  expect(verify([text, 'first', 'second'].join('\n')).textDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(() => verify([text, 'first', 'second'].join('\n\n'))).toThrow()
  expect(() => verify([text, 'second', 'first'].join('\n'))).toThrow()
})
