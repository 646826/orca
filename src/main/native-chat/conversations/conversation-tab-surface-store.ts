import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionStoreTransactions } from '../../runtime/agent-session-store-transactions'
import type { AgentSessionStoreState } from '../../runtime/agent-session-store-state'
import { agentSessionExecutionLocationsEqual } from '../../../shared/agent-session-record'
import { ConversationRefusal, readParticipant } from './conversation-read-model'
import { requireConversation, requireRecord } from './conversation-store-transitions'
import {
  readConversationTabSurface,
  readConversationTabBinding,
  listConversationTabSurfaces,
  type ConversationTabScope,
  type ConversationTabSurface
} from './conversation-tab-surface'

export type PromoteConversationSurface = {
  conversationId: string
  sourceSessionId: string
  expectedTabId: string
  expectedRevision: number
}
export class ConversationTabSurfaceStore {
  constructor(
    private readonly host: JournalHostDatabase,
    private readonly transactions: AgentSessionStoreTransactions
  ) {}

  readByTab = (tabId: string) => readConversationTabBinding(this.host.db, tabId)
  read = (conversationId: string) => readConversationTabSurface(this.host.db, conversationId)
  list = (scope: ConversationTabScope) => listConversationTabSurfaces(this.host.db, scope)

  async promote(
    input: PromoteConversationSurface,
    admission: () => void
  ): Promise<ConversationTabSurface> {
    return this.commit((state) => {
      admission()
      const db = this.host.db
      const conversation = requireConversation(db, input.conversationId)
      const record = requireRecord(state, input.sourceSessionId)
      const member = readParticipant(db, input.sourceSessionId)
      if (
        member?.conversationId !== input.conversationId ||
        !agentSessionExecutionLocationsEqual(record.location, conversation.location)
      ) {
        throw new ConversationRefusal('scope-mismatch')
      }
      const existing = this.read(input.conversationId)
      if (existing) {
        if (
          existing.tabId !== input.expectedTabId ||
          existing.sourceSessionId !== input.sourceSessionId
        ) {
          throw new ConversationRefusal('identity-mismatch')
        }
        return existing
      }
      if (conversation.revision !== input.expectedRevision) {
        throw new ConversationRefusal('stale-generation')
      }
      if (
        !input.expectedTabId ||
        state.sessionTabs?.tabIdFor(input.sourceSessionId) !== input.expectedTabId
      ) {
        throw new ConversationRefusal('identity-mismatch')
      }
      const deleted = db
        .prepare('DELETE FROM agent_session_tabs WHERE tab_id=? AND session_id=?')
        .run(input.expectedTabId, input.sourceSessionId)
      if (deleted.changes !== 1) {
        throw new ConversationRefusal('identity-mismatch')
      }
      state.sessionTabs.hide(input.sourceSessionId)
      db.prepare(`INSERT INTO conversation_tabs(conversation_id,source_session_id,tab_id,
        execution_host_id,workspace_id,location_json,visible,surface_revision,published_revision)
        VALUES(?,?,?,?,?,?,1,1,0)`).run(
        input.conversationId,
        input.sourceSessionId,
        input.expectedTabId,
        conversation.location.executionHostId,
        conversation.location.workspaceId,
        JSON.stringify(conversation.location)
      )
      return this.requireSurface(input.conversationId)
    })
  }

  async setVisibility(
    input: { conversationId: string; expectedSurfaceRevision: number; visible: boolean },
    admission: () => void
  ): Promise<ConversationTabSurface> {
    return this.commit(() => {
      admission()
      const surface = this.requireSurface(input.conversationId, input.expectedSurfaceRevision)
      if (surface.visible !== input.visible) {
        this.host.db
          .prepare(
            'UPDATE conversation_tabs SET visible=?,surface_revision=surface_revision+1 WHERE conversation_id=?'
          )
          .run(input.visible ? 1 : 0, input.conversationId)
      }
      return this.requireSurface(input.conversationId)
    })
  }

  async acknowledge(input: {
    conversationId: string
    expectedSurfaceRevision: number
  }): Promise<ConversationTabSurface> {
    return this.commit(() => {
      this.requireSurface(input.conversationId, input.expectedSurfaceRevision)
      this.host.db
        .prepare(
          'UPDATE conversation_tabs SET published_revision=surface_revision WHERE conversation_id=?'
        )
        .run(input.conversationId)
      return this.requireSurface(input.conversationId)
    })
  }

  private requireSurface(id: string, revision?: number): ConversationTabSurface {
    const surface = this.read(id)
    if (!surface) {
      throw new ConversationRefusal('missing-record')
    }
    if (revision !== undefined && surface.surfaceRevision !== revision) {
      throw new ConversationRefusal('stale-generation')
    }
    return surface
  }

  private async commit(
    write: (state: AgentSessionStoreState) => ConversationTabSurface
  ): Promise<ConversationTabSurface> {
    let result: ConversationTabSurface | undefined
    const receipt = this.transactions.receipt((state) => {
      result = write(state)
    })
    await this.transactions.commitReceipt(receipt)
    if (!result) {
      throw new ConversationRefusal('missing-record')
    }
    return result
  }
}
