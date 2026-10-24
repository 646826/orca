import { expect, it, vi } from 'vitest'
import { beginSwitch } from './structured-conversation-switch.test-fixture'
import { CALLER, envelope, hostTestState } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import { canDispatchConversationSubmission } from './structured-conversation-switch-dispatch'

it('drains only submissions accepted within the frozen source boundary', async () => {
  const { host } = await beginSwitch(async () => {
    const { host } = hostTestState()
    const body = hostTestMessage('accepted before freeze')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await vi.waitFor(() => expect(hostTestState().dispatch).toHaveBeenCalledOnce())
  })
  const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const prior = journal.submissions()[0]!
  expect(
    canDispatchConversationSubmission(host.deps, HOST_TEST_SESSION, journal.cursor().epoch, prior)
  ).toBe(true)
  expect(
    canDispatchConversationSubmission(host.deps, HOST_TEST_SESSION, journal.cursor().epoch, {
      ...prior,
      acceptedSequence: journal.cursor().sequence + 1
    })
  ).toBe(false)
})

it('does not start or dispatch a candidate submission without a verified reserved transfer', async () => {
  const { host, targetId, store } = await beginSwitch()
  const journal = host.collaboratorsForTests().sessions.get(targetId)!.journal
  await journal.appendSubmission({
    clientMessageId: 'unreserved-candidate',
    origin: 'host',
    payloadFingerprint: 'candidate',
    body: hostTestMessage('unreserved'),
    fence: store.getRecord(targetId)!.lease.runtimeFence,
    handoverRecorded: true
  })
  await host.collaboratorsForTests().serialize(targetId, async () => {})
  const submission = journal.submissions()[0]!
  expect(
    canDispatchConversationSubmission(host.deps, targetId, journal.cursor().epoch, submission)
  ).toBe(false)
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
  expect(submission.handedOverAt).toBeUndefined()
})

it('refuses runtime dispatch without a founded record even when a journal submission exists', async () => {
  const { host } = await beginSwitch()
  const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  await journal.appendSubmission({
    clientMessageId: 'no-record',
    origin: 'host',
    payloadFingerprint: 'f',
    body: hostTestMessage('never send'),
    fence: 1,
    handoverRecorded: true
  })
  const submission = journal.submissions().find((row) => row.clientMessageId === 'no-record')
  if (!submission) {
    throw new Error('submission fixture missing')
  }
  expect(
    canDispatchConversationSubmission(
      host.deps,
      'missing-record',
      journal.cursor().epoch,
      submission
    )
  ).toBe(false)
  expect(hostTestState().dispatch).not.toHaveBeenCalled()
})
