import { afterEach, expect, vi } from 'vitest'
import {
  fakeClaude,
  adapterAtPublishFor,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { nativeTriggerFixture } from '../agent-session-wire/structured-conversation-native-trigger.fixture'
import { readConversationTransferNoWrite } from './conversation-transfer-no-write'

const close: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of close.splice(0).toReversed()) {
    await cleanup()
  }
})

export async function noWriteFixture() {
  const f = await nativeTriggerFixture({
    handle: claudeProviderHandle(PROVIDER_SESSION_ID, null),
    params: {
      agent: 'claude',
      provider: 'claude',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
      options: { model: 'opus' }
    }
  })
  const claude = fakeClaude({
    initProof: 'none',
    replayUuid: null,
    initModels: [{ value: 'opus' }]
  })
  const adapter = adapterAtPublishFor(claude, {}, [], [], undefined, undefined, undefined, f.settle)
  close.push(async () => {
    await adapter.closeAll()
  })
  const acquired = await adapter.acquire({ ...f.acquisition, onSpawned: undefined })
  await adapter.open({
    sessionId: f.targetId,
    fence: f.acquisition.fence,
    acquisitionGeneration: acquired.acquisitionGeneration!,
    signal: new AbortController().signal
  })
  f.dispatch.mockImplementation((input) => adapter.dispatch(input))
  const aborts = f.host.collaboratorsForTests().runtimeState.acquireAborts
  const handover = async () => {
    await f.append()
    await vi.waitFor(() =>
      expect(f.journal.submission(f.request.targetSubmissionId)?.dispatchState).not.toBe('pending')
    )
    await f.flush()
  }
  const proof = () => readConversationTransferNoWrite(f.db, f.request.transferId)
  return { ...f, adapter, claude, aborts, handover, proof }
}

export async function refusedNoWriteFixture() {
  const f = await noWriteFixture()
  f.host.deps.bindConversationEvidencePlan = async () => {
    throw new Error('refused before native input')
  }
  return f
}
