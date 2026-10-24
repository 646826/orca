import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationTransferIntention } from '../../../../shared/conversation-transfer-recovery'
import type { useNativeChatConversationControls } from './use-native-chat-conversation-controls'
import { NativeChatCopyButton } from './NativeChatCopyButton'

export function NativeChatTransferRecoveryPanel({
  controls
}: {
  controls: Pick<
    ReturnType<typeof useNativeChatConversationControls>,
    | 'transferRecovery'
    | 'recoverTransfer'
    | 'readOlderIntentions'
    | 'reconcileTransferStatus'
    | 'busy'
  >
}): React.JSX.Element | null {
  const view = controls.transferRecovery
  if (!view || (!view.intentions.length && !view.next)) {
    return null
  }
  return (
    <div className="space-y-2">
      {view.intentions.map((intention) => (
        <section
          key={intention.transferId}
          className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground"
        >
          <p>{statusLabel(intention.status)}</p>
          {intention.kind === 'queued-continuation' ? (
            <p>
              {translate(
                'components.native-chat.transferRecovery.continuation',
                'Retained queued message. Recovery will not cancel the already active conversation.'
              )}
            </p>
          ) : null}
          <p className="break-words text-muted-foreground">
            {translate(
              'components.native-chat.transferRecovery.identity',
              'Target: {{target}} · Switch: {{operation}}',
              { target: intention.targetSessionId, operation: intention.operationKey }
            )}
          </p>
          {intention.original ? (
            <>
              <p>
                {intention.original.truncated
                  ? translate(
                      'components.native-chat.transferRecovery.preview',
                      'Truncated original text preview. The complete original is retained on the host.'
                    )
                  : translate(
                      'components.native-chat.transferRecovery.original',
                      'Original text (read-only)'
                    )}
              </p>
              <pre className="whitespace-pre-wrap break-words text-xs">
                {intention.original.text}
              </pre>
              <p className="break-all text-muted-foreground">
                {translate(
                  'components.native-chat.transferRecovery.metadata',
                  'Original body: {{bytes}} bytes · Attachments: {{count}} · SHA-256: {{digest}}',
                  {
                    bytes: intention.original.bodyBytes,
                    count: intention.original.attachmentCount,
                    digest: intention.original.bodyDigest
                  }
                )}
              </p>
              <NativeChatCopyButton
                text={intention.original.text}
                label={
                  intention.original.truncated
                    ? translate(
                        'components.native-chat.transferRecovery.copyPreview',
                        'Copy text preview only'
                      )
                    : translate(
                        'components.native-chat.transferRecovery.copyOriginal',
                        'Copy original text'
                      )
                }
              />
            </>
          ) : (
            <p>
              {translate(
                'components.native-chat.transferRecovery.unavailable',
                'The retained original cannot currently be verified. Recovery is unavailable; the intention has not been deleted.'
              )}
            </p>
          )}
          {intention.scope && intention.actions.length ? (
            <>
              <p className="text-muted-foreground">
                {translate(
                  'components.native-chat.transferRecovery.disclosure',
                  'The message was not sent. Provider settings may have changed. Returning it keeps the draft held; sending or switching again requires a separate action and fresh consent.'
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {intention.actions.includes('return-held-draft') ? (
                  <Button
                    size="sm"
                    disabled={controls.busy}
                    onClick={() => {
                      void controls.recoverTransfer(intention, 'return-held-draft')
                    }}
                  >
                    {translate(
                      'components.native-chat.transferRecovery.returnDraft',
                      'Return held draft'
                    )}
                  </Button>
                ) : null}
                {intention.actions.includes('cancel-retain') ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={controls.busy}
                    onClick={() => {
                      void controls.recoverTransfer(intention, 'cancel-retain')
                    }}
                  >
                    {translate(
                      'components.native-chat.transferRecovery.cancelRetain',
                      'Cancel transfer and keep original'
                    )}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </section>
      ))}
      {view.intentions.some((entry) => entry.status === 'delivery-uncertain') ? (
        <Button
          size="sm"
          variant="outline"
          disabled={controls.busy}
          onClick={() => {
            void controls.reconcileTransferStatus()
          }}
        >
          {translate('components.native-chat.transferRecovery.reconcile', 'Refresh status')}
        </Button>
      ) : null}
      {view.next ? (
        <Button
          size="sm"
          variant="outline"
          disabled={controls.busy}
          onClick={() => {
            void controls.readOlderIntentions()
          }}
        >
          {translate('components.native-chat.transferRecovery.older', 'Older retained intentions')}
        </Button>
      ) : null}
    </div>
  )
}

function statusLabel(status: ConversationTransferIntention['status']): string {
  switch (status) {
    case 'message-not-sent':
      return translate('components.native-chat.transferRecovery.notSent', 'Message was not sent')
    case 'returned-held':
      return translate(
        'components.native-chat.transferRecovery.returned',
        'Original returned as a held draft. It has not been sent again.'
      )
    case 'cancelled-retained':
      return translate(
        'components.native-chat.transferRecovery.cancelled',
        'Transfer cancelled. The failed intention and original are retained.'
      )
    case 'accepted':
      return translate(
        'components.native-chat.transferRecovery.accepted',
        'Delivery accepted; recovery is unavailable.'
      )
    case 'delivery-uncertain':
      return translate(
        'components.native-chat.transferRecovery.uncertain',
        'Delivery uncertain. Reconcile delivery; the original is read-only and will not be resent.'
      )
  }
}
