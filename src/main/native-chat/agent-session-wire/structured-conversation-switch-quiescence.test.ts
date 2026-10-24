import { describe, expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState,
  seedApproval,
  CALLER,
  envelope
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import { readStructuredConversationQuiescence } from './structured-conversation-switch-quiescence'

function snapshot(
  overrides: Partial<Parameters<typeof readStructuredConversationQuiescence>[0]> = {}
) {
  const { host, store } = hostTestState()
  return readStructuredConversationQuiescence(
    {
      store,
      sessions: host.collaboratorsForTests().sessions,
      adapter: host.deps.adapter,
      readChildWork: () => [],
      childWorkOpen: () => false,
      childWorkIncomplete: () => false,
      starting: () => false,
      stopping: () => false,
      hasOpenDispatch: () => false,
      ...overrides
    },
    HOST_TEST_SESSION
  )
}

describe('production host quiescence evidence', () => {
  it('does not call an unopened journal safe', () => {
    expect(snapshot().blockers).toContain('unopened')
  })

  it('reads an idle attached host without claiming workspace exclusivity', async () => {
    await attach()
    // Attach publishes the child before its protocol-open settlement marks it ready.
    await vi.waitFor(() =>
      expect(snapshot()).toMatchObject({
        ready: true,
        blockers: [],
        externalWorkspaceWriters: 'unknown'
      })
    )
  })

  it('sees provider approvals committed through the real event sink', async () => {
    await attach()
    await seedApproval()
    expect(snapshot().blockers).toContain('pending-prompts')
  })

  it('keeps an admitted native send unsettled after foreground ownership is released', async () => {
    await attach()
    const { host, dispatch } = hostTestState()
    dispatch.mockResolvedValue({ state: 'admitted' })
    const body = hostTestMessage('pending native acceptance')
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    host.deps.adapter.heldSends = () => new Set()
    expect(snapshot().blockers).toContain('unsettled-submission')
  })

  it('does not infer safe idle from incomplete background evidence or supervised ownership', async () => {
    await attach()
    expect(
      snapshot({ childWorkIncomplete: () => true, hasOpenDispatch: () => true }).blockers
    ).toEqual(expect.arrayContaining(['background-incomplete', 'supervised-work']))
  })

  it('keeps startup and Stop settlement separate from foreground work', async () => {
    await attach()
    expect(snapshot({ starting: () => true, stopping: () => true }).blockers).toEqual(
      expect.arrayContaining(['starting', 'stopping'])
    )
  })
})
