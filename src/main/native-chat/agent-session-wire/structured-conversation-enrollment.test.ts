import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { expect, it } from 'vitest'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

it('enrollment waits for an already admitted session mutation without holding a second queue', async () => {
  await attach()
  const { host, store } = hostTestState()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const mutation = host['serialize'](HOST_TEST_SESSION, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  let enrollment: ReturnType<typeof host.conversationEnrollment.ensure>
  try {
    enrollment = host.conversationEnrollment.ensure(HOST_TEST_SESSION)
  } catch (error) {
    release.resolve()
    await mutation
    throw error
  }
  await Promise.resolve()
  expect(store.conversations.membership(HOST_TEST_SESSION)).toBeNull()
  release.resolve()
  await mutation
  expect((await enrollment).activeSegmentId).toBeTruthy()
  expect(store.conversations.membership(HOST_TEST_SESSION)).not.toBeNull()
})

it('candidate membership waits on only the target queue and uses the current durable identity', async () => {
  await attach()
  const { host, store, root } = hostTestState()
  const source = store.getRecord(HOST_TEST_SESSION)!
  const targetId = 'enrollment-target'
  await store.founding.commit({
    sessionId: targetId,
    provider: 'codex',
    location: source.location,
    accountHome: source.accountHome,
    expectedFence: null,
    spawnToken: 'target-found',
    claimKeyId: 'target-key',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: hostTestOperationId(),
      fingerprint: 'target-founding'
    },
    now: HOST_TEST_NOW
  })
  const journal = await openAgentSessionJournal({
    database: openTestJournalHostDatabase(root),
    identity: {
      sessionId: targetId,
      workspaceId: source.location.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: null
    }
  })
  try {
    const conversation = await host.conversationEnrollment.ensure(HOST_TEST_SESSION)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mutation = host['serialize'](targetId, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const beginning = host.conversationEnrollment.begin(
      {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedContextGeneration: 1,
        expectedActivationFence: conversation.activationFence,
        expectedNativeBindingGeneration: 1,
        target: store.getRecord(targetId)!
      },
      {
        callerKey: 'test',
        operationId: hostTestOperationId(),
        fingerprint: 'switch',
        now: HOST_TEST_NOW
      }
    )
    await Promise.resolve()
    expect(store.conversations.membership(targetId)).toBeNull()
    release.resolve()
    await mutation
    const result = await beginning
    expect(result.intent?.targetSessionId).toBe(targetId)
    expect(store.conversations.route(targetId).role).toBe('candidate')
  } finally {
    await journal.close()
  }
})
