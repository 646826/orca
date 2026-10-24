import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createOriginFixture, identity, old, fresh, item } from './conversation-origin.fixture'
import { bindConversationOrigin, readConversationOrigin } from './conversation-origin'
import {
  assertConversationOriginsResolved,
  readConversationRowOrigins
} from './conversation-origin-rows'
let fixture: Awaited<ReturnType<typeof createOriginFixture>>
beforeEach(async () => {
  fixture = await createOriginFixture()
})
afterEach(async () => {
  await fixture.close()
})
async function submit() {
  const { host, journal } = fixture
  host.transaction((db) =>
    bindConversationOrigin(db, {
      sessionId: 'a',
      key: { kind: 'submission', id: 'user-send' },
      origin: old
    })
  )
  await journal.appendSubmission({
    clientMessageId: 'user-send',
    payloadFingerprint: 'exact-send',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
    fence: 1
  })
}
async function emit() {
  await fixture.journal.appendItem(
    identity,
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'provider echo with independently transformed text' }]
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  return fixture.journal.cursor()
}
it('binds accepted provider item identity without matching message text', async () => {
  await submit()
  await fixture.journal.resolveDispatch({
    clientMessageId: 'user-send',
    fence: 1,
    state: 'accepted',
    providerIdentity: identity,
    originCorrelation: 'exact'
  })
  expect(readConversationOrigin(fixture.host.db, 'a', item, 1)).toEqual(old)
  await emit()
  expect(() => assertConversationOriginsResolved(fixture.host.db, 'c', 1)).not.toThrow()
})
it('reconciles item-before-ack origin in the actual accepted dispatch transaction', async () => {
  await submit()
  const cursor = await emit()
  expect(() => assertConversationOriginsResolved(fixture.host.db, 'c', 1)).toThrow('unresolved')
  await fixture.journal.resolveDispatch({
    clientMessageId: 'user-send',
    fence: 1,
    state: 'accepted',
    providerIdentity: identity,
    originCorrelation: 'exact'
  })
  expect(() => assertConversationOriginsResolved(fixture.host.db, 'c', 1)).not.toThrow()
  expect(
    readConversationRowOrigins(fixture.host.db, {
      sessionId: 'a',
      epoch: cursor.epoch,
      sequence: cursor.sequence
    })
  ).toEqual([{ atomPath: '$', origin: old }])
})
it('does not create an item alias from an accepted command without a provider identity', async () => {
  await submit()
  await fixture.journal.resolveDispatch({
    clientMessageId: 'user-send',
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  await emit()
  expect(() => assertConversationOriginsResolved(fixture.host.db, 'c', 1)).toThrow('unresolved')
})

it('does not promote legacy accepted content correlation into strict origin authority', async () => {
  await submit()
  await fixture.journal.resolveDispatch({
    clientMessageId: 'user-send',
    fence: 1,
    state: 'accepted',
    providerIdentity: identity
  })
  await emit()
  expect(readConversationOrigin(fixture.host.db, 'a', item, 1)).toBeNull()
  expect(() => assertConversationOriginsResolved(fixture.host.db, 'c', 1)).toThrow('unresolved')
})
it('keeps exact correlation on canonical journal reopen', async () => {
  await submit()
  await fixture.journal.resolveDispatch({
    clientMessageId: 'user-send',
    fence: 1,
    state: 'accepted',
    providerIdentity: identity,
    originCorrelation: 'exact'
  })
  await fixture.journal.close()
  const reopened = await openAgentSessionJournal({
    database: fixture.host,
    identity: {
      sessionId: 'a',
      workspaceId: 'ws',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('native')
    }
  })
  try {
    expect(reopened.receiptFor('user-send')?.originCorrelation).toBe('exact')
  } finally {
    await reopened.close()
  }
})
it('rolls back conflicting exact alias without publishing a false acceptance receipt', async () => {
  await submit()
  fixture.host.transaction((db) =>
    bindConversationOrigin(db, { sessionId: 'a', key: item, origin: fresh })
  )
  await expect(
    fixture.journal.resolveDispatch({
      clientMessageId: 'user-send',
      fence: 1,
      state: 'accepted',
      providerIdentity: identity,
      originCorrelation: 'exact'
    })
  ).rejects.toThrow('cannot be rebound')
  expect(fixture.journal.receiptFor('user-send')).toBeNull()
  expect(readConversationOrigin(fixture.host.db, 'a', item, 1)).toEqual(fresh)
})
