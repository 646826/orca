import { NativeChatConversationArchive } from './NativeChatConversationArchive'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { captureConversationReaderOwner } from '@/runtime/conversation-reader-owner'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import { ConversationClearViewSchema } from '../../../../shared/conversation-clear-record'
import { structuredSessionOperationId } from './structured-agent-session-operation-id'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { nativeChatConversationRequestFailure } from './native-chat-conversation-notices'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export function NativeChatConversationClear({
  snapshot,
  target,
  onRefresh
}: {
  snapshot: ConversationSurfaceSnapshot
  target: RuntimeClientTarget
  onRefresh: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<NativeChatComposerNotice | null>(null)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const owner = useMemo(
    () =>
      captureConversationReaderOwner(
        environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
      ),
    [environmentId]
  )
  const clear = snapshot.clear
  const conversation = snapshot.conversation
  const identity = `${conversation.conversationId}:${conversation.contextGeneration}:${conversation.activationFence}:${conversation.pendingOperationKey ?? ''}`
  const lifetime = useMemo(
    () => ({
      owner,
      identity,
      active: false,
      flight: false,
      operationId: structuredSessionOperationId()
    }),
    [owner, identity]
  )
  const current = useRef(lifetime)
  current.current = lifetime
  useEffect(() => {
    lifetime.active = true
    setBusy(false)
    setConfirming(false)
    setNotice(null)
    const stop = owner.subscribe(() => {
      lifetime.active = false
    })
    return () => {
      lifetime.active = false
      stop()
    }
  }, [lifetime, owner])
  async function run(action: 'begin' | 'advance' | 'cancel' | (() => Promise<void>)) {
    if (lifetime.flight || !lifetime.active || !owner.current()) {
      return
    }
    lifetime.flight = true
    setBusy(true)
    setNotice(null)
    const isCurrent = () => lifetime.active && owner.current() && current.current === lifetime
    try {
      if (typeof action === 'function') {
        await action()
      } else if (action === 'begin') {
        const result = z.object({ intent: ConversationClearViewSchema.nullable() }).parse(
          await owner.request('conversation.clear', {
            conversationId: conversation.conversationId,
            expectedRevision: conversation.revision,
            expectedContextGeneration: conversation.contextGeneration,
            expectedActivationFence: conversation.activationFence,
            clientOperationId: lifetime.operationId
          })
        )
        if (!result.intent) {
          throw new Error('Conversation clear was not admitted')
        }
      } else if (clear) {
        await owner.request(
          action === 'advance' ? 'conversation.clearAdvance' : 'conversation.clearCancel',
          {
            operationKey: clear.operationKey,
            expectedVersion: clear.version
          }
        )
      }
    } catch (cause) {
      if (isCurrent()) {
        setNotice(nativeChatConversationRequestFailure(cause))
      }
    } finally {
      if (isCurrent()) {
        setBusy(false)
        setConfirming(false)
        await onRefresh().catch((cause) => {
          if (isCurrent()) {
            setNotice(nativeChatConversationRequestFailure(cause))
          }
        })
      }
      lifetime.flight = false
    }
  }
  return (
    <div className="space-y-2">
      {notice ? <NativeChatComposerNotices notices={[notice]} /> : null}
      {clear ? (
        <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
          <p>
            {clear.phase === 'reconciliation-required'
              ? translate(
                  'components.native-chat.agentSwitch.clearUnknown',
                  'Native shutdown is unconfirmed. Reconcile before clearing context.'
                )
              : translate(
                  'components.native-chat.agentSwitch.clearPending',
                  'Context clear is pending. Finish active work and approvals, then continue.'
                )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run('advance')}>
              {translate(
                'components.native-chat.agentSwitch.continueClear',
                'Continue context clear'
              )}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run('cancel')}>
              {translate('components.native-chat.agentSwitch.cancelClear', 'Cancel context clear')}
            </Button>
          </div>
          <p className="text-muted-foreground">
            {translate(
              'components.native-chat.agentSwitch.clearCancelDisclosure',
              'Cancelling leaves any already stopped agents at rest. It does not undo native side effects.'
            )}
          </p>
        </div>
      ) : confirming ? (
        <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
          <p>
            {translate(
              'components.native-chat.agentSwitch.clearDisclosure',
              'Start a fresh context generation for every agent in this conversation. Old native sessions will not resume. The visible archive remains; this does not erase provider data.'
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || Boolean(conversation.pendingOperationKey)}
              onClick={() => void run('begin')}
            >
              {translate(
                'components.native-chat.agentSwitch.confirmClear',
                'Clear all agents and keep archive'
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {translate('components.native-chat.agentSwitch.keepContext', 'Keep current context')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || Boolean(conversation.pendingOperationKey)}
          onClick={() => setConfirming(true)}
        >
          {translate('components.native-chat.agentSwitch.clearContext', 'Clear context')}
        </Button>
      )}
      {conversation.contextGeneration > 1 ? (
        <NativeChatConversationArchive
          key={`${environmentId ?? 'local'}:${identity}`}
          snapshot={snapshot}
          busy={busy}
          request={owner.request}
          run={run}
        />
      ) : null}
    </div>
  )
}
