import { CONVERSATION_TRANSFER_RECOVERY_METHODS } from './conversation-transfer-recovery-methods'
import { CONVERSATION_ARCHIVE_METHODS } from './conversation-archive-methods'
import { CONVERSATION_CLEAR_METHODS } from './conversation-clear-methods'
import { readConversationSegmentPage } from '../../../native-chat/conversations/conversation-segment-page'
import { ConversationRpcRefusal } from '../../../../shared/conversation-rpc-refusal'
import { conversationOperationView, boundedConversationResult } from './conversation-public-result'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { requireStructuredAgentAudience } from './structured-agent-session-gate'
import {
  readConversationHistoricalPage,
  conversationHistoryRevision
} from '../../../native-chat/conversations/conversation-history'
import { defineMethod } from '../core'
import {
  ConversationPreparationEvidenceParams,
  ConversationTrustParams,
  ConversationEnsureParams,
  ConversationSwitchParams,
  ConversationHistoryParams,
  ConversationReadParams,
  ConversationOperationParams,
  ConversationAdvanceParams,
  ConversationRecipientParams,
  ConversationManifestParams,
  ConversationCancelParams
} from '../../../../shared/rpc-contract/conversation-params'
import {
  conversationRpcHost,
  conversationRpcCaller,
  requireConversationRecord,
  conversationOperationHost
} from './conversation-method-access'

export const CONVERSATION_METHODS = [
  ...CONVERSATION_TRANSFER_RECOVERY_METHODS,
  ...CONVERSATION_CLEAR_METHODS,
  ...CONVERSATION_ARCHIVE_METHODS,
  defineMethod({
    name: 'conversation.preparationEvidence',
    permission: 'workspace',
    params: ConversationPreparationEvidenceParams,
    handler: async (params, ctx) => {
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      const controls = host.deps.conversationPreparationControls
      if (!controls) {
        throw new ConversationRpcRefusal('unsupported')
      }
      return controls.evidence(params)
    }
  }),
  defineMethod({
    name: 'conversation.evidenceTrust',
    permission: 'workspace',
    params: ConversationOperationParams,
    handler: async (params, ctx) => {
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      const choice = host.deps.conversationEvidenceTrust?.read(params.operationKey)
      return boundedConversationResult(
        choice ? { status: 'choice' as const, choice } : { status: 'unavailable' as const }
      )
    }
  }),
  defineMethod({
    name: 'conversation.approveEvidenceTrust',
    permission: 'workspace',
    params: ConversationTrustParams,
    handler: async (params, ctx) => {
      const callerKey = conversationRpcCaller(ctx)
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      const trust = host.deps.conversationEvidenceTrust
      if (!trust) {
        throw new ConversationRpcRefusal('unsupported')
      }
      trust.approve(params, callerKey)
      return { status: 'approved' as const }
    }
  }),
  defineMethod({
    name: 'conversation.ensure',
    permission: 'workspace',
    params: ConversationEnsureParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record) {
        throw new ConversationRpcRefusal('source-unavailable')
      }
      requireStructuredAgentAudience(ctx, record.provider)
      const conversation = await host.conversationEnrollment.ensure(params.sessionId)
      if (!params.includeSourceSurface) {
        return conversation
      }
      requireConversationRecord(host, ctx, conversation.conversationId)
      const surface = host.deps.store.conversations.surfaces.read(conversation.conversationId)
      if (surface && surface.sourceSessionId !== params.sessionId) {
        throw new ConversationRpcRefusal('scope-mismatch')
      }
      const sourceTabId = surface?.tabId ?? host.deps.store.getSessionTabId(params.sessionId)
      if (!sourceTabId) {
        throw new ConversationRpcRefusal('source-unavailable')
      }
      return { ...conversation, sourceTabId }
    }
  }),
  defineMethod({
    name: 'conversation.switch',
    permission: 'workspace',
    params: ConversationSwitchParams,
    handler: async (params, ctx) => {
      const callerKey = conversationRpcCaller(ctx)
      const host = await conversationRpcHost(ctx)
      requireConversationRecord(host, ctx, params.conversationId)
      const target = host.deps.store.getRecord(params.targetSessionId)
      if (!target) {
        throw new ConversationRpcRefusal('target-unavailable')
      }
      requireStructuredAgentAudience(ctx, target.provider)
      const { clientOperationId, targetSessionId, ...generation } = params
      const result = await host.conversationEnrollment.begin(
        {
          ...generation,
          target: {
            sessionId: targetSessionId,
            provider: target.provider,
            location: target.location,
            accountHome: target.accountHome
          }
        },
        {
          callerKey,
          operationId: clientOperationId,
          now: Date.now(),
          fingerprint: computeAgentSessionPayloadFingerprint({
            method: 'conversation.switch',
            sessionId: targetSessionId,
            fields: generation
          })
        }
      )
      return boundedConversationResult({
        decision: result.decision.decision,
        ...(result.decision.decision === 'refused'
          ? { code: result.decision.code, details: result.decision.details }
          : {}),
        intent: result.intent ? conversationOperationView(result.intent) : null
      })
    }
  }),
  defineMethod({
    name: 'conversation.history',
    permission: 'workspace',
    params: ConversationHistoryParams,
    handler: async (params, ctx) => {
      const host = await conversationRpcHost(ctx, 'read')
      requireConversationRecord(host, ctx, params.conversationId)
      return readConversationHistoricalPage({
        ...params,
        db: host.deps.journalDatabase.db,
        scratchDirectory: host.deps.journalDatabase.stateDirectory,
        signal: ctx.signal ?? new AbortController().signal
      })
    }
  }),
  defineMethod({
    name: 'conversation.read',
    permission: 'workspace',
    params: ConversationReadParams,
    handler: async (params, ctx) => {
      const host = await conversationRpcHost(ctx, 'read')
      const conversation = requireConversationRecord(host, ctx, params.conversationId)
      if (params.segmentPage) {
        const page = readConversationSegmentPage(
          host.deps.journalDatabase.db,
          params.conversationId,
          params.segmentPage.beforeOrdinal,
          params.segmentPage.limit
        )
        return boundedConversationResult({
          conversation,
          segments: page.segments.map((segment) => ({
            ...segment,
            sourceRevision: conversationHistoryRevision(
              host.deps.journalDatabase.db,
              params.conversationId,
              segment.segmentId
            )
          })),
          references: [],
          next: null,
          nextSegmentOrdinal: page.nextSegmentOrdinal
        })
      }
      const refs = host.deps.store.conversations.timelinePage(
        params.conversationId,
        params.after ?? null,
        params.limit
      )
      const selected = new Set(refs.map((ref) => ref.segmentId))
      selected.add(conversation.activeSegmentId)
      const segments = host.deps.store.conversations
        .segments(params.conversationId)
        .filter((segment) => selected.has(segment.segmentId))
        .map((segment) => ({
          ...segment,
          sourceRevision: conversationHistoryRevision(
            host.deps.journalDatabase.db,
            params.conversationId,
            segment.segmentId
          )
        }))
      return boundedConversationResult({
        conversation,
        segments,
        references: refs,
        next: refs.at(-1)?.cursor ?? null
      })
    }
  }),
  defineMethod({
    name: 'conversation.preparation',
    permission: 'workspace',
    params: ConversationOperationParams,
    handler: async (params, ctx) => {
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      return host.deps.conversationPreparationControls?.read(params.operationKey) ?? null
    }
  }),
  defineMethod({
    name: 'conversation.approveRecipient',
    permission: 'workspace',
    params: ConversationRecipientParams,
    handler: async (params, ctx) => {
      const callerKey = conversationRpcCaller(ctx)
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      const controls = host.deps.conversationPreparationControls
      if (!controls) {
        throw new ConversationRpcRefusal('unsupported')
      }
      controls.approveRecipient(params, callerKey)
      return controls.read(params.operationKey)
    }
  }),
  defineMethod({
    name: 'conversation.approveManifest',
    permission: 'workspace',
    params: ConversationManifestParams,
    handler: async (params, ctx) => {
      const callerKey = conversationRpcCaller(ctx)
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      const controls = host.deps.conversationPreparationControls
      if (!controls) {
        throw new ConversationRpcRefusal('unsupported')
      }
      controls.approveManifest(params, callerKey)
      return controls.read(params.operationKey)
    }
  }),
  defineMethod({
    name: 'conversation.advance',
    permission: 'workspace',
    params: ConversationAdvanceParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const { host, intent } = await conversationOperationHost(ctx, params.operationKey)
      if (intent.version !== params.expectedVersion) {
        throw new ConversationRpcRefusal('stale-generation')
      }
      const result = await host.advanceConversationSwitch(
        params.operationKey,
        ctx.signal ?? new AbortController().signal
      )
      // Publication follows the durable operation; its failure never rolls back or replays native work.
      const conversation = host.deps.store.conversations.read(intent.conversationId)
      if (conversation) {
        await ctx.runtime.publishConversationSurfaces(conversation.location.executionHostId)
      }
      return boundedConversationResult(result)
    }
  }),
  defineMethod({
    name: 'conversation.cancel',
    permission: 'workspace',
    params: ConversationCancelParams,
    handler: async (params, ctx) => {
      conversationRpcCaller(ctx)
      const { host } = await conversationOperationHost(ctx, params.operationKey)
      return boundedConversationResult(
        conversationOperationView(await host.deps.store.conversations.cancel(params))
      )
    }
  })
] as const
