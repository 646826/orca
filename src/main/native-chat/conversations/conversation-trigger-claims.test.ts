import { triggerClaimsFixture } from './conversation-trigger-claims.test-fixture'
import { expect, it } from 'vitest'
import { hostTestState } from '../agent-session-wire/structured-agent-session-host-test-harness'
import { beginSwitch } from '../agent-session-wire/structured-conversation-switch.test-fixture'
import {
  createConversationTriggerAuthority,
  prepareConversationTrigger
} from './conversation-trigger-claims'

it('does not authorize a binding without an immutable delivery plan', async () => {
  await beginSwitch()
  const { host } = hostTestState()
  const authority = createConversationTriggerAuthority({
    stateDirectory: host.deps.journalDatabase.stateDirectory,
    getRecord: (id) => host.deps.store.getRecord(id),
    getJournal: (id) => host.collaboratorsForTests().sessions.get(id)?.journal ?? null,
    readPreparationEvidence: () => null
  })
  expect(
    authority.verifyTriggerClaims(host.deps.journalDatabase.db, {
      transferId: 'unproved',
      kind: 'trigger',
      deliveryPlanId: 'absent',
      operationKey: 'absent',
      conversationId: 'absent',
      contextGeneration: 1,
      candidateGeneration: 2,
      candidateSegmentId: 'absent',
      nativeBindingGeneration: 1,
      queueSessionId: 'source',
      messageId: 'draft',
      sourceFingerprint: 'unproved',
      expectedQueueState: 'waiting',
      targetSessionId: 'target',
      targetSubmissionId: 'submission',
      targetFingerprint: 'unproved',
      targetOptionsDigest: 'unproved',
      manifestId: 'absent',
      manifestDigest: 'unproved',
      attachmentClaimsDigest: 'unproved'
    })
  ).toBe(false)
})

it('derives exact native target payload from the real queued draft and refuses changed options', async () => {
  const fixture = await triggerClaimsFixture()
  const prepared = await prepareConversationTrigger(
    fixture.db,
    fixture.request,
    fixture.claimsHost,
    1,
    new AbortController().signal
  )
  expect(prepared.authority.verifyTriggerClaims(fixture.db, prepared.binding)).toBe(true)
  expect(prepared.body.blocks.at(-1)).toEqual(fixture.draft.body.blocks[0])
  expect(prepared.body.blocks[0]).toMatchObject({ type: 'text' })
  const bad = { ...prepared.binding, targetOptionsDigest: 'wrong' }
  expect(prepared.authority.verifyTriggerClaims(fixture.db, bad)).toBe(false)
  expect(fixture.source.queuedMessages.get(fixture.draft.messageId)?.state).toBe('waiting')
  expect(fixture.dispatch).not.toHaveBeenCalled()
})
