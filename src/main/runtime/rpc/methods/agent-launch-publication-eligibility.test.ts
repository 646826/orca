import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { resetAgentLaunchPanesForTests } from '../../../agent-launch/agent-launch-pane-attachment'
import type { AgentLaunchTabPublishRequest } from '../../../../shared/agent-launch-tab-publication'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStubOptions
} from './agent-launch.test-fixture'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const replay = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const CLI = {}
let directory: string
let store: AgentSessionRecordStore
let sequence = 0

function nextOperationId(): string {
  return `${Date.now()}-${(++sequence).toString(16).padStart(32, '0')}`
}

function hostWithWindow(options: AgentLaunchRuntimeStubOptions = {}) {
  const published: Omit<AgentLaunchTabPublishRequest, 'requestId'>[] = []
  const runtime = runtimeStub({
    settings: {},
    ...options,
    publishAgentLaunchTab: async (request) => {
      published.push(request)
      return { tabId: request.tabId, created: true, placement: { groupId: 'group-1' } }
    }
  })
  return Object.assign(runtime, {
    published,
    publishAgentLaunchTabInMainLayout: vi.fn(
      (request: Omit<AgentLaunchTabPublishRequest, 'requestId'>) =>
        runtime.publishAgentLaunchTab(request)
    ),
    withdrawAgentLaunchPaneInMainLayout: vi.fn(() => true)
  })
}

function coldRecord(runtime: ReturnType<typeof hostWithWindow>) {
  runtime.readAgentLaunchPublicationEligibility.mockResolvedValueOnce('unknown')
  return runtime
}

function replayLaunch(
  runtime: ReturnType<typeof hostWithWindow>,
  params: Record<string, unknown>,
  context: typeof CLI
) {
  return replay.handler(
    replay.params.parse({
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:wt-7' },
      ...params
    }),
    rpcContext(runtime, context)
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-launch-publication-eligibility-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})
afterEach(async () => {
  setAgentLaunchRecordStore(null)
  resetAgentLaunchPanesForTests()
  layoutOwner.isMain = false
  await rm(directory, { recursive: true, force: true })
})

describe.each(['window', 'main'] as const)('the %s owning the layout', (owner) => {
  beforeEach(() => {
    layoutOwner.isMain = owner === 'main'
  })
  describe('optional ledger reads', () => {
    it.each(['cold', 'failed'] as const)(
      'suppresses only the optional tab when publication eligibility is %s',
      async (state) => {
        const operationId = nextOperationId()
        const runtime = hostWithWindow({ terminalPaneKey: PANE_KEY })
        if (state === 'cold') {
          coldRecord(runtime)
        } else {
          runtime.readAgentLaunchPublicationEligibility.mockRejectedValueOnce(
            new Error('optional ledger read failed')
          )
        }
        await expect(
          replayLaunch(runtime, { paneKey: PANE_KEY, operationId }, CLI)
        ).resolves.toMatchObject({
          outcome: { kind: 'terminal', handle: 'term_1' }
        })
        expect(runtime.published).toEqual([])
        expect(runtime.openAgentLaunchLedger).toHaveBeenCalledOnce()
        expect(runtime.createTerminal).toHaveBeenCalledOnce()
        expect(store.listOperationRows()).toHaveLength(1)
        expect(store.listOperationRows()[0]?.outcome.status).toBe('succeeded')
        const retried = coldRecord(
          hostWithWindow({ adoptedPanes: { [PANE_KEY]: 'term_recovered' } })
        )
        await expect(
          replayLaunch(retried, { paneKey: PANE_KEY, operationId }, CLI)
        ).resolves.toMatchObject({
          outcome: { kind: 'terminal', handle: 'term_recovered' }
        })
        expect(retried.published).toEqual([])
        expect(retried.createTerminal).not.toHaveBeenCalled()
      }
    )
  })
})
