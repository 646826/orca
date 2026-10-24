import { expect, it } from 'vitest'
import { triggerClaimsFixture } from '../native-chat/conversations/conversation-trigger-claims.test-fixture'
import { createRuntimeConversationPreparationFactory } from './structured-conversation-preparation-factory'
it('publishes only observed startup choices through the real preparation factory', async () => {
  const f = await triggerClaimsFixture()
  const target = f.store.getRecord(f.targetId)
  if (!target) {
    throw new Error('missing target')
  }
  const service = createRuntimeConversationPreparationFactory(
    f.db,
    f.host.deps.journalDatabase.stateDirectory
  )({
    getRecord: f.deliveryHost.getRecord,
    getJournal: f.deliveryHost.getJournal,
    contextDeliveryCapabilities: () => ({ state: 'unverified' })
  })
  expect(service.captureConversationEvidenceLaunch).toBeTypeOf('function')
  const capture = service.captureConversationEvidenceLaunch?.(
    f.targetId,
    target.lease.runtimeFence,
    undefined,
    f.intent.operationKey
  )
  expect(capture).toBeDefined()
  expect(() =>
    capture?.observe({
      launchFingerprint: 'actual-resolved',
      transport: 'codex-dynamic-tool',
      resuming: false
    })
  ).toThrow('startup trust')
  const choice = service.evidenceTrust?.read(f.intent.operationKey)
  expect(choice?.scope.launchFingerprint).toBe('actual-resolved')
  expect(() =>
    service.evidenceTrust?.approve(
      { operationKey: f.intent.operationKey, choiceDigest: 'forged' },
      'client'
    )
  ).toThrow()
  if (!choice) {
    throw new Error('missing choice')
  }
  service.evidenceTrust?.approve(
    { operationKey: f.intent.operationKey, choiceDigest: choice.choiceDigest },
    'client'
  )
  const permit = capture?.observe({
    launchFingerprint: 'actual-resolved',
    transport: 'codex-dynamic-tool',
    resuming: false
  })
  expect(permit).toBeDefined()
  expect(() => permit?.assertBeforeSpawn()).not.toThrow()
})
