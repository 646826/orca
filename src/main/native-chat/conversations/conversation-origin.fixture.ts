import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { createConversationOriginTablesSql } from './conversation-origin-schema'
import { createConversationOriginRowHook } from './conversation-origin-rows'
import type { ConversationOriginScope } from './conversation-origin'
export const identity = {
  provider: 'codex' as const,
  threadId: 'native',
  turnId: 'old-turn',
  ordinal: 1
}
export const old = {
  conversationId: 'c',
  segmentId: 'a1',
  contextGeneration: 1,
  nativeBindingGeneration: 1
}
export const fresh = { ...old, segmentId: 'a3' }
export const item = { kind: 'item' as const, id: agentJournalItemKey(identity) }
export async function createOriginFixture(scope: () => ConversationOriginScope = () => old) {
  const root = mkdtempSync(join(tmpdir(), 'orca-origin-'))
  const host = JournalHostDatabase.open(root)
  host.db.exec(createConversationOriginTablesSql())
  const journal = new AgentSessionJournal({
    identity: {
      sessionId: 'a',
      workspaceId: 'ws',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('native')
    },
    database: host,
    requiredInTransaction: createConversationOriginRowHook('a', scope)
  })
  await journal.open()
  host.db.prepare('INSERT INTO conversations VALUES(?,?)').run('c', '{}')
  host.db.prepare('INSERT INTO conversation_participants VALUES(?,?,?)').run('a', 'c', '{}')
  for (const [index, origin] of [old, fresh].entries()) {
    host.db.prepare('INSERT INTO conversation_segments VALUES(?,?,?,?)').run(
      origin.segmentId,
      'c',
      index + 1,
      JSON.stringify({
        ...origin,
        sessionId: 'a',
        ordinal: index + 1,
        activationFence: index + 1,
        startSequence: 1,
        boundary: { sessionId: 'a', epoch: journal.cursor().epoch, endSequence: 1 }
      })
    )
  }
  return {
    host,
    journal,
    async close() {
      await journal.close()
      host.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
