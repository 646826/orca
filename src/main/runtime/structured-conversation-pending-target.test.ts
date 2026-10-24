import { expect, it } from 'vitest'
import { triggerClaimsFixture } from '../native-chat/conversations/conversation-trigger-claims.test-fixture'
import { hostTestState } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { createRuntimeConversationPreparationFactory } from './structured-conversation-preparation-factory'
it('does not advertise an unpublished pending native identity as a usable target', async () => {
  const { host } = hostTestState()
  host.deps.adapter.open = async () => ({ reportedOptions: { model: 'fixture-model' } })
  host.deps.adapter.projectOptions = () => ({
    models: [],
    options: { model: 'fixture-model' }
  })
  const f = await triggerClaimsFixture(undefined, {
    handle: codexProviderHandle('019fd532-7c11-7a90-b6de-4e1a2c3d5f61'),
    params: { options: { model: 'fixture-model' } }
  })
  const target = f.store.getRecord(f.targetId)!
  const service = createRuntimeConversationPreparationFactory(
    f.db,
    f.host.deps.journalDatabase.stateDirectory
  )({
    getRecord: f.deliveryHost.getRecord,
    getJournal: f.deliveryHost.getJournal,
    contextDeliveryCapabilities: () => ({
      state: 'verified',
      runtimeFingerprint: 'fixture',
      acquisitionGeneration: 'fixture-acquisition',
      passiveImport: 'unsupported',
      firstTurnReceipt: 'live-acceptance',
      nonMutatingHydration: 'unsupported',
      startupTrust: 'unverified',
      resume: 'native',
      artifactAccess: ['text'],
      budget: 'unknown'
    }),
    projectOptions: f.host.deps.adapter.projectOptions?.bind(f.host.deps.adapter)
  })
  expect(service.controls?.read(f.intent.operationKey)?.target).toMatchObject({
    sessionId: f.targetId,
    model: 'fixture-model'
  })
  f.db
    .prepare('INSERT INTO conversation_pending_native_identity VALUES(?,?,?,?,?,?,?,?,NULL,NULL,0)')
    .run(
      f.targetId,
      target.lease.runtimeFence,
      f.intent.operationKey,
      '{}',
      'fixture-acquisition',
      'process',
      'scope',
      '[]'
    )
  expect(() => service.controls?.read(f.intent.operationKey)).toThrow(
    'pending native publication unverified'
  )
})
