import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentLaunchResult } from '../../shared/agent-launch-intent'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { AgentLaunchLedgerOwner } from './agent-launch-ledger'

let directory: string
let owner: AgentLaunchLedgerOwner
let request: { callerKey: string; operationId: string; fingerprint: string; now: number }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-launch-ledger-'))
  owner = new AgentLaunchLedgerOwner(await openTestAgentSessionRecordStore(directory))
  const now = Date.now()
  request = {
    callerKey: 'caller',
    operationId: `${now}-000000000000000000000000000000aa`,
    fingerprint: 'fp',
    now
  }
})

afterEach(async () => {
  await owner.stopAndDrain()
  await rm(directory, { recursive: true, force: true })
})

function result(): AgentLaunchResult {
  return {
    outcome: { kind: 'terminal', handle: 'term_1' },
    worktreeId: 'folder-1',
    receipt: {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'requested',
      detail: 'Requested terminal'
    }
  }
}

it('durably claims once and never reruns an unsettled claim', async () => {
  const answers = await Promise.all([owner.admit(request), owner.admit(request)])
  expect(answers.map((answer) => answer.decision)).toEqual(['execute', 'refuse'])
  await owner.stopAndDrain()
  closeTestJournalHostDatabase(directory)
  const reopened = new AgentLaunchLedgerOwner(await openTestAgentSessionRecordStore(directory))
  try {
    await expect(reopened.admit(request)).resolves.toMatchObject({
      decision: 'refuse',
      refusal: { code: 'agent_session_operation_unknown' }
    })
  } finally {
    await reopened.stopAndDrain()
  }
})

it('captures command input and returns isolated replay DTOs without normalizing extensions', async () => {
  await owner.admit(request)
  const recorded = { ...result(), extension: { future: 'kept' } }
  const writing = owner.record({ ...request, result: recorded })
  recorded.extension.future = 'mutated'
  recorded.outcome.handle = 'changed'
  await writing
  const answer = await owner.admit(request)
  expect(answer).toMatchObject({
    decision: 'replay',
    result: { extension: { future: 'kept' }, outcome: { handle: 'term_1' } }
  })
  if (answer.decision !== 'replay') {
    throw new Error('Expected replay')
  }
  answer.result.worktreeId = 'changed'
  await expect(owner.admit(request)).resolves.toMatchObject({
    decision: 'replay',
    result: { worktreeId: 'folder-1' }
  })
})

it('orders publication reads after an admitted write and drains before rejecting old endpoint work', async () => {
  const admitting = owner.admit(request)
  const reading = owner.publicationEligibility(request)
  const stopping = owner.stopAndDrain()
  await expect(admitting).resolves.toMatchObject({ decision: 'execute' })
  await expect(reading).resolves.toBe('recorded')
  await stopping
  await expect(owner.publicationEligibility(request)).rejects.toThrow('agent_launch_ledger_stopped')
  await expect(owner.record({ ...request, result: result() })).rejects.toThrow(
    'agent_launch_ledger_stopped'
  )
})

it('keeps provisional and final settlement invocation order without awaiting the first reply', async () => {
  await owner.admit(request)
  const provisional = {
    ...result(),
    prompt: { delivery: 'submit' as const, outcome: 'unconfirmed' as const }
  }
  const final = {
    ...result(),
    prompt: { delivery: 'submit' as const, outcome: 'handed-to-terminal' as const }
  }
  const first = owner.record({ ...request, result: provisional })
  const second = owner.record({ ...request, result: final })
  const reading = owner.publicationEligibility(request)
  await Promise.all([first, second, reading])
  await expect(owner.admit(request)).resolves.toEqual({ decision: 'replay', result: final })
})
