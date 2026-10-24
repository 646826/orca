import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { StructuredAgentSessionResumeAdmission } from './structured-agent-session-restart-resume-runner'
import {
  interruptedRestart,
  QUIT_CUT_NOTICE,
  readerNotes,
  statusNotes,
  continuationCannotFold
} from './structured-agent-session-restart-interruption-test-harness'
import {
  CALLER,
  envelope,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

// Which outcomes of a restart action become a failure the user is shown, and what retires one.

afterEach(() => vi.restoreAllMocks())

// Nothing was owed once the user's own message came first: the offer is spent and nothing is filed.
it('files nothing for a chat the user moved on in before its attempt, and spends the offer', async () => {
  const { host, root, dispatch } = await interruptedRestart()
  await host.restartResume.list()
  const admit = StructuredAgentSessionResumeAdmission.prototype.run
  vi.spyOn(StructuredAgentSessionResumeAdmission.prototype, 'run').mockImplementationOnce(
    async function (this, ...args) {
      const body = hostTestMessage('A newer task from another client')
      await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
      return admit.apply(this, args)
    }
  )

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued.filter((entry) => entry.outcome === 'continued')).toEqual([])
  expect(result.failed).toEqual([])
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  const capsule = new AgentSessionRecoveryCapsule(root)
  expect(await capsule.listFailed(NOW)).toEqual([])
  expect(await capsule.list(NOW)).toEqual([])
  // Only the quit's own row about the cut: no note took over, so it stays the turn's one notice.
  expect(await statusNotes(host)).toEqual([QUIT_CUT_NOTICE])
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])
})

// The continuation is accepted and its agent then fails to start: the message is rejected with the
// cause, the failure is filed, and the chat says the agent did not carry on.
it('says so in the chat when the agent cannot start for the continuation', async () => {
  const { host, acquire } = await interruptedRestart()
  await host.restartResume.list()
  acquire.mockRejectedValueOnce(new Error('provider could not reconnect'))
  // Before the action, the quit's cut reads with its one notice.
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])

  await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, outcome: 'refused', retryable: true }
  ])
  expect(await statusNotes(host)).toContainEqual({
    text: AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
    tone: 'error'
  })
  // The refusal note is now the one explanation: the cut is not said a second time beside it.
  expect(await readerNotes(host)).toEqual(await statusNotes(host))
})

// A continuation that carries on, chosen in the prompt or automatically at launch, does not stand in
// for the cut: its note is written after its own message, so the cut keeps its notice throughout.
it("keeps the quit's notice through a continuation that carries the chat on", async () => {
  const { host } = await interruptedRestart()
  await host.restartResume.list()
  expect(await readerNotes(host)).toEqual([QUIT_CUT_NOTICE])

  const result = await host.restartResume.continueAfterRestart([SESSION], 'modal')

  expect(result.continued).toMatchObject([{ outcome: 'continued' }])
  expect(await readerNotes(host)).toEqual([
    QUIT_CUT_NOTICE,
    { text: AGENT_SESSION_RESTART_CONTINUATION_NOTE, tone: undefined }
  ])
})

it('persists an unconfirmed failure when poisoning prevents its note, then recovers on restart', async () => {
  const { host, root, log, dispatch, acquire } = await interruptedRestart()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await host.restartResume.list()
  const fold = continuationCannotFold()

  const result = await host.restartResume
    .continueAfterRestart([SESSION], 'modal')
    .finally(() => fold.mockRestore())

  expect(result.continued).toMatchObject([{ sessionId: SESSION, outcome: 'unknown' }])
  expect(result.failed).toMatchObject([{ sessionId: SESSION, outcome: 'unconfirmed' }])
  // The poisoned handle refuses even the best-effort note; the capsule and diagnostics survive.
  expect(await statusNotes(host)).toEqual([QUIT_CUT_NOTICE])
  expect(log.entries).toContainEqual({
    level: 'warn',
    message: 'writing a restart continuation note failed',
    fields: { scope: 'restart-continuation-note', sessionId: SESSION }
  })
  expect(warning).toHaveBeenCalledWith(
    '[agent-session] restart-continuation-note: writing a restart continuation note failed',
    { scope: 'restart-continuation-note', sessionId: SESSION }
  )
  const capsule = new AgentSessionRecoveryCapsule(root)
  const failures = await capsule.listFailed(NOW)
  expect(failures).toMatchObject([{ marker: { sessionId: SESSION }, outcome: 'unconfirmed' }])
  expect(await host.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, outcome: 'unconfirmed' }
  ])
  expect(acquire).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()

  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabase(root)
  const store = await openTestAgentSessionRecordStore(root)
  const restarted = new StructuredAgentSessionHost({
    ...host.deps,
    store,
    journalDatabase: openTestJournalHostDatabase(root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(root)
  })
  replaceHostTestState({ host: restarted, store })
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual(failures)
  expect(await restarted.restartResume.listFailures()).toMatchObject([
    { sessionId: SESSION, outcome: 'unconfirmed', retryable: true }
  ])
  expect((await restarted.journalSnapshot(SESSION)).submissions).toMatchObject([
    { dispatchState: 'rejected' }
  ])
  expect(acquire).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()

  expect(await restarted.restartResume.continueAfterRestart([SESSION], 'retry')).toMatchObject({
    continued: [{ sessionId: SESSION, outcome: 'continued' }],
    failed: []
  })
  expect(acquire).toHaveBeenCalledOnce()
  expect(dispatch).toHaveBeenCalledOnce()
  expect((await restarted.journalSnapshot(SESSION)).submissions).toMatchObject([
    { dispatchState: 'rejected' },
    { dispatchState: 'accepted' }
  ])
  expect(await restarted.restartResume.listFailures()).toEqual([])
  expect(await new AgentSessionRecoveryCapsule(root).listFailed(NOW)).toEqual([])
})
