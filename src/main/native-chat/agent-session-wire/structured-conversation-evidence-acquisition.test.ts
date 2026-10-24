import { expect, it, vi } from 'vitest'
import {
  attach,
  attachParams,
  CALLER,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import { AgentSessionPreSpawnError } from './structured-agent-session-adapter'

it('captures evidence launch authority before acquisition and passes that exact capture to the adapter', async () => {
  const state = hostTestState()
  const events: string[] = []
  const capture = {
    observe: vi.fn(() => {
      throw new Error('not used by this transport fixture')
    })
  }
  const captureLaunch = vi.fn(
    (
      sessionId: string,
      fence: number,
      signal: AbortSignal | undefined,
      expectedOperationKey: string | null
    ) => {
      events.push('capture')
      expect(sessionId).toBe(HOST_TEST_SESSION)
      expect(fence).toBeGreaterThan(0)
      expect(signal?.aborted).toBe(false)
      expect(expectedOperationKey).toBeNull()
      return capture
    }
  )
  state.host.deps.captureConversationEvidenceLaunch = captureLaunch
  const acquire = state.acquire.getMockImplementation()!
  state.acquire.mockImplementation(async (input) => {
    events.push('acquire')
    expect(input.evidenceLaunch).toBe(capture)
    return acquire(input)
  })
  await attach()
  expect(events).toEqual(['capture', 'acquire'])
  expect(captureLaunch).toHaveBeenCalledOnce()
})

it('refuses stale capture before invoking any native acquisition or cleanup of an unspawned child', async () => {
  const state = hostTestState()
  state.host.deps.captureConversationEvidenceLaunch = () => {
    throw new Error('candidate changed')
  }
  await expect(state.host.attach(CALLER, attachParams())).rejects.toBeInstanceOf(
    AgentSessionPreSpawnError
  )
  expect(state.acquire).not.toHaveBeenCalled()
  expect(state.releaseAcquisition).not.toHaveBeenCalled()
})
