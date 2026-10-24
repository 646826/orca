import { useNativeChatTransferRecovery } from './use-native-chat-transfer-recovery'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { useEffect, useMemo, useRef, useState } from 'react'
import { captureConversationReaderOwner } from '@/runtime/conversation-reader-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  ConversationSelectAgentResultSchema,
  type ConversationSurfaceSnapshot
} from '../../../../shared/conversation-surface-rpc'
import {
  ConversationEvidenceTrustChoiceSchema,
  type ConversationEvidenceTrustChoice
} from '../../../../shared/conversation-evidence-trust'
import type {
  ConversationPreparationView,
  ConversationPreparationEvidencePage
} from '../../../../shared/conversation-rpc'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import {
  nativeChatConversationNotice,
  nativeChatConversationRequestFailure
} from './native-chat-conversation-notices'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import type { NativeChatAgentSwitchPickerProps } from './NativeChatAgentSwitchPicker'

export type NativeChatConversationControlsInput = {
  snapshot: ConversationSurfaceSnapshot
  target: RuntimeClientTarget
  onRefresh: () => Promise<void>
}

export function useNativeChatConversationControls({
  snapshot,
  target,
  onRefresh
}: NativeChatConversationControlsInput) {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState<NativeChatComposerNotice | null>(null)
  const [preparation, setPreparation] = useState<ConversationPreparationView | null>(null)
  const [trust, setTrust] = useState<ConversationEvidenceTrustChoice | null>(null)
  const [evidence, setEvidence] = useState<ConversationPreparationEvidencePage | null>(null)
  const operation = snapshot.operation
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const rpcTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const owner = useMemo(() => captureConversationReaderOwner(rpcTarget), [rpcTarget])
  const { request } = owner
  useEffect(() => owner.subscribe(() => {}), [owner])
  const targetKey = environmentId === null ? 'local:' : `environment:${environmentId}`
  const scopeKey = `${targetKey}:${snapshot.conversation.conversationId}:${snapshot.conversation.contextGeneration}:${operation?.operationKey ?? ''}:${operation?.version ?? 0}:${snapshot.conversation.revision}:${reload}`
  const evidenceGeneration = useRef(0)
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  useEffect(() => {
    evidenceGeneration.current += 1
    let current = true
    const abort = new AbortController()
    setPreparation(null)
    setTrust(null)
    setEvidence(null)
    if (!operation || operation.phase === 'activated' || operation.phase === 'cancelled') {
      return () => abort.abort()
    }
    void Promise.all([
      request<ConversationPreparationView | null>(
        'conversation.preparation',
        { operationKey: operation.operationKey },
        { signal: abort.signal }
      ),
      request<unknown>(
        'conversation.evidenceTrust',
        { operationKey: operation.operationKey },
        { signal: abort.signal }
      )
    ])
      .then(([view, trustResult]) => {
        if (!current) {
          return
        }
        if (
          view?.operationKey === operation.operationKey &&
          view.contextGeneration === operation.contextGeneration
        ) {
          setPreparation(view)
        }
        if (trustResult && typeof trustResult === 'object' && 'choice' in trustResult) {
          const parsed = ConversationEvidenceTrustChoiceSchema.safeParse(trustResult.choice)
          if (
            parsed.success &&
            parsed.data.scope.operationKey === operation.operationKey &&
            parsed.data.scope.contextGeneration === operation.contextGeneration &&
            parsed.data.scope.targetSessionId === operation.targetSessionId
          ) {
            setTrust(parsed.data)
          }
        }
      })
      .catch((cause) => {
        if (current) {
          setError(nativeChatConversationRequestFailure(cause))
        }
      })
    return () => {
      current = false
      abort.abort()
    }
  }, [request, operation, snapshot.conversation.revision, reload])

  async function run(action: () => Promise<unknown>, refresh = true): Promise<void> {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    const admittedScope = currentScope.current
    try {
      await action()
    } catch (cause) {
      if (currentScope.current === admittedScope) {
        setError(nativeChatConversationRequestFailure(cause))
      }
    } finally {
      if (refresh && currentScope.current === admittedScope) {
        try {
          await onRefresh()
        } catch (cause) {
          if (currentScope.current === admittedScope) {
            setError(nativeChatConversationRequestFailure(cause))
          }
        }
      }
      inFlight.current = false
      setBusy(false)
      if (refresh && currentScope.current === admittedScope) {
        setReload((value) => value + 1)
      }
    }
  }
  const select = (
    agent: string,
    nativeSession: 'retain-or-create' | 'rebuild' = 'retain-or-create'
  ) => {
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'opencode') {
      return
    }
    return run(async () => {
      const conversation = snapshot.conversation
      ConversationSelectAgentResultSchema.parse(
        await request<unknown>('conversation.selectAgent', {
          conversationId: conversation.conversationId,
          expectedRevision: conversation.revision,
          expectedContextGeneration: conversation.contextGeneration,
          expectedActivationFence: conversation.activationFence,
          agent,
          nativeSession,
          clientOperationId: structuredSessionOperationId()
        })
      )
    })
  }
  const approveManifest = (view: ConversationPreparationView) =>
    run(async () => {
      if (view.status !== 'preview' || !view.preview || view.preview.policy !== 'budgeted') {
        return
      }
      const preview = view.preview
      await request('conversation.approveManifest', {
        operationKey: view.operationKey,
        expectedVersion: view.operationVersion,
        expectedContextGeneration: view.contextGeneration,
        manifestDigest: preview.manifestDigest,
        targetBindingDigest: preview.targetBindingDigest,
        capabilityFingerprint: preview.capabilityFingerprint,
        transformationsDigest: preview.transformationsDigest,
        omissionsDigest: preview.omissionsDigest
      })
    })
  const approvePolicy = (policy: 'full' | 'budgeted') =>
    run(async () => {
      if (!preparation?.target || preparation.status !== 'recipient-choice') {
        return
      }
      await request('conversation.approveRecipient', {
        operationKey: preparation.operationKey,
        expectedVersion: preparation.operationVersion,
        expectedContextGeneration: preparation.contextGeneration,
        expectedApprovalRevision: preparation.approvalRevision,
        targetBindingDigest: preparation.target.bindingDigest,
        capabilityFingerprint: preparation.target.capabilityFingerprint,
        policy,
        disclosure: 'available-canonical'
      })
    })
  const advance = () =>
    run(async () => {
      if (!operation) {
        return
      }
      await request('conversation.advance', {
        operationKey: operation.operationKey,
        expectedVersion: operation.version
      })
    })
  const cancel = () =>
    run(async () => {
      if (!operation) {
        return
      }
      const conversation = snapshot.conversation
      await request('conversation.cancel', {
        operationKey: operation.operationKey,
        expectedVersion: operation.version,
        expectedRevision: conversation.revision,
        expectedContextGeneration: conversation.contextGeneration,
        expectedActivationFence: conversation.activationFence
      })
    })
  const approveTrust = () =>
    run(async () => {
      if (!trust) {
        return
      }
      await request('conversation.approveEvidenceTrust', {
        operationKey: trust.scope.operationKey,
        choiceDigest: trust.choiceDigest
      })
    })
  const readEvidence = (view: ConversationPreparationView, after = 0) =>
    run(async () => {
      if (view.status !== 'preview' || !view.preview) {
        return
      }
      const requestedScope = currentScope.current
      const requestedGeneration = evidenceGeneration.current
      const page = await request<ConversationPreparationEvidencePage>(
        'conversation.preparationEvidence',
        {
          operationKey: view.operationKey,
          manifestDigest: view.preview.manifestDigest,
          after,
          limit: 32
        }
      )
      if (
        currentScope.current !== requestedScope ||
        evidenceGeneration.current !== requestedGeneration
      ) {
        return
      }
      if (
        page.manifestDigest !== view.preview.manifestDigest ||
        page.targetBindingDigest !== view.preview.targetBindingDigest ||
        page.transformationsDigest !== view.preview.transformationsDigest ||
        page.omissionsDigest !== view.preview.omissionsDigest
      ) {
        throw new Error('Context preview changed')
      }
      setEvidence(page)
    }, false)
  const recovery = useNativeChatTransferRecovery({ snapshot, scopeKey, request, run })
  const status = nativeChatConversationNotice(operation)
  const agentSwitch: NativeChatAgentSwitchPickerProps = {
    active: { id: snapshot.active.agent, label: snapshot.active.agentLabel },
    selected: snapshot.selected
      ? { id: snapshot.selected.agent, label: snapshot.selected.agentLabel }
      : null,
    choices: (['claude', 'codex', 'opencode'] as const).map((agent) => ({
      id: agent,
      label: structuredAgentLabel(agent)
    })),
    busy:
      busy ||
      Boolean(snapshot.conversation.pendingOperationKey) ||
      Boolean(operation && operation.phase !== 'activated' && operation.phase !== 'cancelled'),
    onSelect: (agent) => {
      void select(agent)
    }
  }
  return {
    busy,
    ...recovery,
    preparation,
    trust,
    evidence,
    agentSwitch,
    notices: [error, status].filter((notice) => notice !== null),
    approveManifest,
    approvePolicy,
    advance,
    cancel,
    approveTrust,
    readEvidence,
    select
  }
}
