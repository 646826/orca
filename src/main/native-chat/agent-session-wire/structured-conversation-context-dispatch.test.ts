import { expect, it, vi } from 'vitest'
import { nativeTriggerFixture } from './structured-conversation-native-trigger.fixture'
import { prepareConversationSubmissionContext } from './structured-conversation-context-dispatch'

it('refuses changed preparation proof after canonical handover without reaching the native adapter', async () => {
  const f = await nativeTriggerFixture(undefined)
  const resolve = f.journal.resolveDispatch.bind(f.journal)
  vi.spyOn(f.journal, 'resolveDispatch').mockImplementation(async (...args) => {
    const result = await resolve(...args)
    if (args[0].state === 'pending') {
      f.deliveryHost.readPreparationEvidence = () => null
    }
    return result
  })
  await f.append()
  await vi.waitFor(() => {
    expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).toBe('rejected')
  })
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(f.journal.submissions()).toHaveLength(1)
  expect(f.journal.receiptFor(f.request.targetSubmissionId)).toBeNull()
  expect(f.db.prepare('SELECT 1 FROM conversation_delivery_inputs').get()).toBeUndefined()
  expect(f.db.prepare('SELECT 1 FROM conversation_delivery_receipts').get()).toBeUndefined()
})

it('checks cancellation before pre-effect reauthorization and leaves ordinary submissions on their existing path', async () => {
  const f = await nativeTriggerFixture(undefined)
  const read = vi.spyOn(f.deliveryHost, 'readPreparationEvidence')
  const signal = AbortSignal.abort(new Error('cancelled before native input'))
  await expect(
    prepareConversationSubmissionContext(
      f.host.deps,
      f.targetId,
      f.request.targetSubmissionId,
      signal
    )
  ).rejects.toThrow('candidate-context-unverified')
  expect(read).not.toHaveBeenCalled()
  expect(f.dispatch).not.toHaveBeenCalled()
  await expect(
    prepareConversationSubmissionContext(f.host.deps, f.targetId, 'not-a-transfer', signal)
  ).resolves.toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})

it('honors cancellation raised during pre-effect validation without native input or a second append', async () => {
  const f = await nativeTriggerFixture(undefined)
  const controller = new AbortController()
  const read = f.deliveryHost.readPreparationEvidence
  f.deliveryHost.readPreparationEvidence = (...args) => {
    controller.abort(new Error('cancelled during validation'))
    return read(...args)
  }
  await expect(
    prepareConversationSubmissionContext(
      f.host.deps,
      f.targetId,
      f.request.targetSubmissionId,
      controller.signal
    )
  ).rejects.toThrow('candidate-context-unverified')
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(f.journal.submissions()).toEqual([])
  expect(f.db.prepare('SELECT 1 FROM conversation_delivery_inputs').get()).toBeUndefined()
})
