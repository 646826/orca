import { afterEach, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { conversationEvidenceToolDefinition } from '../native-chat/conversations/conversation-evidence-tool-contract'
import { openAcpAdapterRig } from './acp-structured-adapter.test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
afterEach(closeProviderTimelineRigs)
it('registers a scoped MCP endpoint only after verified OpenCode HTTP capability', async () => {
  const confirm = vi.fn()
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode')!,
    initialize: {
      protocolVersion: 1,
      agentInfo: { name: 'opencode', version: '1.19.4' },
      agentCapabilities: { mcpCapabilities: { http: true } }
    }
  })
  await rig.acquire({
    evidenceLaunch: {
      observe: () => ({
        assertBeforeSpawn: vi.fn(),
        registration: {
          definition: conversationEvidenceToolDefinition(),
          invoke: vi.fn(),
          confirm,
          close: vi.fn(async () => {})
        }
      })
    }
  })
  expect(rig.sent('session/new')[0]?.params).toMatchObject({
    mcpServers: [
      {
        type: 'http',
        name: 'orca-conversation-evidence',
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/)
      }
    ]
  })
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ transport: 'acp-http-mcp', nativeSessionId: 'acp-session-1' })
  )
})
it('refuses unsupported native HTTP capability before starting a session', async () => {
  const rig = await openAcpAdapterRig({
    spec: acpLaunchSpecFor('opencode')!,
    initialize: { protocolVersion: 1, agentInfo: { name: 'opencode', version: '1.19.4' } }
  })
  await rig.acquire({
    evidenceLaunch: {
      observe: () => ({
        assertBeforeSpawn: vi.fn(),
        registration: {
          definition: conversationEvidenceToolDefinition(),
          invoke: vi.fn(),
          confirm: vi.fn(),
          close: vi.fn(async () => {})
        }
      })
    }
  })
  expect(rig.sent('session/new')).toEqual([])
  expect(rig.openFailure()).toBeDefined()
})

it('revokes a permit rejected immediately before spawn without launching a native process', async () => {
  const close = vi.fn(async () => {})
  const rig = await openAcpAdapterRig({ spec: acpLaunchSpecFor('opencode')! })
  await expect(
    rig.acquire({
      evidenceLaunch: {
        observe: () => ({
          assertBeforeSpawn: () => {
            throw new Error('revoked')
          },
          registration: {
            definition: conversationEvidenceToolDefinition(),
            invoke: vi.fn(),
            confirm: vi.fn(),
            close
          }
        })
      }
    })
  ).rejects.toThrow()
  expect(close).toHaveBeenCalledTimes(1)
  expect(rig.spawned).toEqual([])
})
