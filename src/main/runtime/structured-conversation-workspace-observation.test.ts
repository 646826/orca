import { expect, it, vi } from 'vitest'
import { foundAgentSessionRecord } from './agent-session-record-founding'
import { createConversationWorkspaceObserver } from './structured-conversation-workspace-observation'
const reads = vi.hoisted(() => ({ runtime: vi.fn(), local: vi.fn(() => null) }))
vi.mock('./file-watcher-host', () => ({ readRuntimeWorkspaceWatchObservation: reads.runtime }))
vi.mock('../ipc/local-watcher-event-observers', () => ({ findCoveringLocalWatchRoot: reads.local }))
const record = foundAgentSessionRecord(
  {
    sessionId: 'session-folder',
    provider: 'codex',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'AGENT_HOME', path: '/accounts/codex' }
  },
  { claimKeyId: 'test', now: 1 }
)
it('uses host-resolved folder scope and reports unavailable resolution as unknown', async () => {
  reads.runtime.mockImplementation((_root: string, scopeDigest: string) => ({
    scopeDigest,
    watchIdentity: 'root',
    revision: 0,
    continuity: 'observed'
  }))
  const resolveRoot = vi.fn(async () => '/actual/host/folder')
  const observer = createConversationWorkspaceObserver(resolveRoot)
  expect(observer.read(record).continuity).toBe('unknown')
  await observer.resolve(record, new AbortController().signal)
  expect(resolveRoot).toHaveBeenCalledWith('folder')
  const initial = observer.read(record)
  expect(initial.continuity).toBe('observed')
  expect(reads.runtime).toHaveBeenLastCalledWith('/actual/host/folder', initial.scopeDigest)
  resolveRoot.mockRejectedValueOnce(new Error('workspace unavailable'))
  await observer.resolve(record, new AbortController().signal)
  expect(observer.read(record).continuity).toBe('unknown')
})
it('does not reinterpret missing, relative, WSL or cancelled resolution as local watch coverage', async () => {
  const signal = new AbortController()
  signal.abort()
  const missing = createConversationWorkspaceObserver(undefined)
  await expect(missing.resolve(record, signal.signal)).rejects.toThrow()
  await missing.resolve(record, new AbortController().signal)
  expect(missing.read(record).continuity).toBe('unknown')
  const relative = createConversationWorkspaceObserver(async () => 'relative/path')
  await relative.resolve(record, new AbortController().signal)
  expect(relative.read(record).continuity).toBe('unknown')
  const wsl = { ...record, location: { ...record.location, wslDistro: 'distribution' } }
  const rooted = createConversationWorkspaceObserver(async () => '/same/path')
  await rooted.resolve(wsl, new AbortController().signal)
  expect(rooted.read(wsl).continuity).toBe('unknown')
})
