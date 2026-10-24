import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'

class TabRuntime extends OrcaRuntimeService {
  readonly refreshing = Promise.withResolvers<void>()
  readonly releaseRefresh = Promise.withResolvers<void>()
  public override hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string> {
    return new Set()
  }
  protected override restoreLivePairedRendererSessionOwnedMobileTerminals(): void {}
  protected override async refreshMobileSessionPtyRecords(): Promise<Set<string>> {
    this.refreshing.resolve()
    await this.releaseRefresh.promise
    return new Set()
  }
  seed(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    this.mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
  }
}

it.each(['close', 'activate'] as const)(
  'rechecks %s after inventory refresh before changing the aggregate tab',
  async (method) => {
    await attach()
    const { store } = hostTestState()
    const runtime = new TabRuntime(null)
    runtime.seed({
      worktree: 'workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [
        {
          type: 'agent-session',
          id: 'chat',
          sessionId: SESSION,
          agent: 'codex',
          title: 'Chat',
          isActive: false
        }
      ]
    })
    const retire = vi.spyOn(runtime, 'retireStructuredAgentSessionTabFromSnapshot')
    const assertAgentSessionMutation = (sessionId: string) => {
      if (store.conversations.membership(sessionId)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
    }
    const pending =
      method === 'close'
        ? runtime.closeMobileSessionTab('id:workspace', 'chat', {
            reason: 'user',
            assertAgentSessionMutation
          })
        : runtime.activateMobileSessionTab('id:workspace', 'chat', undefined, {
            assertAgentSessionMutation,
            notifyClients: false
          })
    const refused = expect(pending).rejects.toMatchObject({
      refusal: { details: { reason: 'clientCapabilityMissing' } }
    })
    await runtime.refreshing.promise
    await store.conversations.ensureSingleton(SESSION)
    runtime.releaseRefresh.resolve()
    await refused
    expect(retire).not.toHaveBeenCalled()
  }
)
