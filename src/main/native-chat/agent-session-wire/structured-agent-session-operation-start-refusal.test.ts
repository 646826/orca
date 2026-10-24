// What an operation that needs the agent is told when it cannot have one: a typed refusal in
// words a person can read, never Orca's own error text.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { startStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'
import { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 'session-1'

describe('an operation whose agent start throws', () => {
  it.each(['scope', 'reconcile'] as const)(
    'refuses a %s read failure without moving admission out of its queue',
    async (failureAt) => {
      const log = recordingStructuredAgentSessionLogger()
      const cause = new Error('EACCES: permission denied, open /Users/me/.orca/leases.json')
      let inLane = false
      const context = {
        deps: {
          logger: log.logger,
          store: {
            conversations: {
              membership: () => {
                expect(inLane).toBe(true)
                if (failureAt === 'scope') {
                  throw cause
                }
                return null
              },
              read: () => null
            }
          }
        },
        sessions: new Map(),
        serialize: (_sessionId: string, task: () => Promise<unknown>) => {
          inLane = true
          try {
            return task()
          } finally {
            inLane = false
          }
        },
        tasks: { trackAttach: (start: Promise<unknown>) => start },
        runtimeState: {
          acquireAborts: new StructuredAgentSessionAcquireAborts(),
          startFlights: new StructuredAgentSessionStartFlights(),
          startupAttempts: { begin: () => {}, abandon: () => {} }
        },
        reconcileLeases: () => Promise.reject(cause)
      }

      const refused = await startStructuredAgentSessionAgentForOperation(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial context double; the start throws in its declared scope reader or reconcileLeases before later dependencies are read.
        context as unknown as StructuredAgentSessionAttachContext,
        SESSION
      )

      expect(refused).toEqual({
        ok: false,
        refusal: {
          code: 'agent_session_owner_restart_failed',
          message: "The agent couldn't restart."
        }
      })
      expect(log.entries.map((entry) => entry.fields)).toEqual([
        { scope: 'operation-agent-start', sessionId: SESSION, error: cause }
      ])
    }
  )
})

describe('an option picked while the chat is at rest', () => {
  it('refuses a key the provider would not accept as a rejected option', async () => {
    const reviseSessionOptions = vi.fn()
    const refused = await recordStructuredAgentSessionOptionIntent(
      {
        store: {
          getRecord: () =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the intent reads only the record's provider and options.
            ({ provider: 'codex', options: {} }) as unknown as AgentSessionRecord,
          replaceSessionOptions: vi.fn(),
          reviseSessionOptions
        },
        agents: claudeAndCodexAgents()
      },
      { sessionId: SESSION, fence: 1, publish: () => {}, now: () => 0 },
      { key: 'notAnOption', value: 'x' }
    )

    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
    expect(reviseSessionOptions).not.toHaveBeenCalled()
  })
})
