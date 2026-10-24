import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import {
  insertJournalRow,
  publishJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

let root: string
let records: AgentSessionRecordStore
const now = 1_800_000_000_000
const identity = (sessionId: string, provider = 'codex') => ({
  sessionId,
  provider,
  location: {
    executionHostId: 'local' as const,
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder' as const
  },
  accountHome: { variable: 'AGENT_HOME', path: `/accounts/${provider}` }
})
function append(sessionId: string, seq: number): void {
  insertJournalRow(openTestJournalHostDatabase(root).db, sessionId, {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: sessionId },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: `epoch-${sessionId}`,
    seq,
    fence: 1,
    ts: seq
  })
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-conversation-store-'))
  await seedTestAgentSessionRecordStore(root, {
    records: ['session-a', 'session-b', 'session-c'].map((id) =>
      foundAgentSessionRecord(identity(id), { claimKeyId: id, now })
    )
  })
  const host = openTestJournalHostDatabase(root)
  records = AgentSessionRecordStore.open({ journalDatabase: host, hostId: 'local' })
  for (const id of ['session-a', 'session-b', 'session-c']) {
    append(id, 1)
    publishJournalSessionEpoch(
      openTestJournalHostDatabase(root).db,
      { sessionId: id, workspaceId: 'folder' },
      `epoch-${id}`
    )
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  rmSync(root, { recursive: true, force: true })
})
it('promotes atomically without changing the native record and replays the same surface', async () => {
  await records.setSessionTabVisibility('session-a', true, 'visual-a')
  const conversation = await records.conversations.ensureSingleton('session-a')
  const before = records.getRecord('session-a')
  const input = {
    conversationId: conversation.conversationId,
    sourceSessionId: 'session-a',
    expectedTabId: 'visual-a',
    expectedRevision: conversation.revision
  }
  const surface = await records.conversations.surfaces.promote(input, () => undefined)
  expect(surface).toMatchObject({
    tabId: 'visual-a',
    visible: true,
    surfaceRevision: 1,
    publishedRevision: 0
  })
  expect(records.getSessionTabId('session-a')).toBeNull()
  expect(records.getRecord('session-a')).toEqual(before)
  expect(await records.conversations.surfaces.promote(input, () => undefined)).toEqual(surface)
  expect(
    records.conversations.surfaces.list({ executionHostId: 'local', workspaceId: 'folder' })
  ).toEqual([surface])
})
it('rolls back SQL detach and draft state on failed durable promotion', async () => {
  await records.setSessionTabVisibility('session-a', true, 'visual-a')
  const c = await records.conversations.ensureSingleton('session-a')
  const db = openTestJournalHostDatabase(root).db
  db.exec(
    "CREATE TRIGGER surface_failure BEFORE INSERT ON conversation_tabs BEGIN SELECT RAISE(ABORT,'injected'); END"
  )
  await expect(
    records.conversations.surfaces.promote(
      {
        conversationId: c.conversationId,
        sourceSessionId: 'session-a',
        expectedTabId: 'visual-a',
        expectedRevision: c.revision
      },
      () => undefined
    )
  ).rejects.toThrow('injected')
  expect(records.getSessionTabId('session-a')).toBe('visual-a')
  expect(
    db.prepare('SELECT session_id FROM agent_session_tabs WHERE tab_id=?').get('visual-a')
  ).toEqual({ session_id: 'session-a' })
})
it('fences stale publication and preserves hidden ownership against native insertion', async () => {
  await records.setSessionTabVisibility('session-a', true, 'visual-a')
  const c = await records.conversations.ensureSingleton('session-a')
  const surfaces = records.conversations.surfaces
  await surfaces.promote(
    {
      conversationId: c.conversationId,
      sourceSessionId: 'session-a',
      expectedTabId: 'visual-a',
      expectedRevision: c.revision
    },
    () => undefined
  )
  const hidden = await surfaces.setVisibility(
    { conversationId: c.conversationId, expectedSurfaceRevision: 1, visible: false },
    () => undefined
  )
  expect(hidden.surfaceRevision).toBe(2)
  await expect(
    surfaces.acknowledge({ conversationId: c.conversationId, expectedSurfaceRevision: 1 })
  ).rejects.toThrow()
  expect(surfaces.list({ executionHostId: 'local', workspaceId: 'folder' })).toEqual([])
  await expect(records.setSessionTabVisibility('session-b', true, 'visual-a')).rejects.toThrow()
  expect(records.getSessionTabId('session-b')).toBeNull()
  expect(
    await surfaces.acknowledge({ conversationId: c.conversationId, expectedSurfaceRevision: 2 })
  ).toMatchObject({ visible: false, publishedRevision: 2 })
})
it('rejects stale or mismatched promotion and exposes all host workspaces', async () => {
  await records.setSessionTabVisibility('session-a', true, 'visual-a')
  const c = await records.conversations.ensureSingleton('session-a')
  const input = {
    conversationId: c.conversationId,
    sourceSessionId: 'session-a',
    expectedTabId: 'visual-a',
    expectedRevision: c.revision
  }
  await expect(
    records.conversations.surfaces.promote(
      { ...input, expectedRevision: c.revision + 1 },
      () => undefined
    )
  ).rejects.toThrow('stale-generation')
  await expect(
    records.conversations.surfaces.promote(
      { ...input, sourceSessionId: 'session-b' },
      () => undefined
    )
  ).rejects.toThrow('scope-mismatch')
  const surface = await records.conversations.surfaces.promote(input, () => undefined)
  expect(records.conversations.surfaces.list({ executionHostId: 'local' })).toEqual([surface])
  await expect(
    records.conversations.surfaces.promote({ ...input, expectedTabId: 'other' }, () => undefined)
  ).rejects.toThrow('identity-mismatch')
  expect(records.conversations.surfaces.read(c.conversationId)?.location).toEqual(c.location)
})
it('guards raw replacement/update collisions and leaves unrelated native tabs writable', async () => {
  await records.setSessionTabVisibility('session-a', true, 'visual-a')
  const c = await records.conversations.ensureSingleton('session-a')
  await records.conversations.surfaces.promote(
    {
      conversationId: c.conversationId,
      sourceSessionId: 'session-a',
      expectedTabId: 'visual-a',
      expectedRevision: c.revision
    },
    () => undefined
  )
  await records.setSessionTabVisibility('session-b', true, 'visual-b')
  const db = openTestJournalHostDatabase(root).db
  expect(() =>
    db
      .prepare(
        'INSERT OR REPLACE INTO agent_session_tabs(tab_id,session_id,position) VALUES(?,?,?)'
      )
      .run('visual-a', 'session-b', 0)
  ).toThrow('conversation owns tab')
  expect(() =>
    db
      .prepare('UPDATE OR REPLACE agent_session_tabs SET tab_id=? WHERE tab_id=?')
      .run('visual-a', 'visual-b')
  ).toThrow('conversation owns tab')
  expect(() =>
    db
      .prepare('UPDATE conversation_tabs SET tab_id=? WHERE conversation_id=?')
      .run('visual-b', c.conversationId)
  ).toThrow('immutable')
  expect(() =>
    db.prepare('INSERT OR REPLACE INTO conversation_tabs SELECT * FROM conversation_tabs').run()
  ).toThrow('already exists')
  expect(records.getSessionTabId('session-b')).toBe('visual-b')
})
it('persists complete execution location, including distro and workspace kind', async () => {
  await records.setSessionTabVisibility('session-a', true, 'visual-a')
  const c = await records.conversations.ensureSingleton('session-a')
  await records.conversations.surfaces.promote(
    {
      conversationId: c.conversationId,
      sourceSessionId: 'session-a',
      expectedTabId: 'visual-a',
      expectedRevision: c.revision
    },
    () => undefined
  )
  const persisted = records.conversations.surfaces.read(c.conversationId)
  expect(persisted?.location).toEqual(c.location)
  expect(persisted?.location).not.toEqual({ ...c.location, wslDistro: 'other-distro' })
  expect(persisted?.location).not.toEqual({ ...c.location, workspaceKind: 'git-worktree' })
})
