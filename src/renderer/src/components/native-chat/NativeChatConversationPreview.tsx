import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationPreparationView } from '../../../../shared/conversation-rpc'

export type NativeChatConversationPreviewProps = {
  view: ConversationPreparationView
  busy: boolean
  onPolicy: (policy: 'full' | 'budgeted') => void
  onApprove: (view: ConversationPreparationView) => void
  onEvidence: (view: ConversationPreparationView) => void
}

export function NativeChatConversationPreview({
  view,
  busy,
  onPolicy,
  onApprove,
  onEvidence
}: NativeChatConversationPreviewProps): React.JSX.Element {
  const stale = view.status === 'stale' || view.workspaceObservation === 'observed-change'
  const preview = view.status === 'preview' && !stale ? view.preview : null
  const effectsPossible = view.phase === 'delivering' || view.phase === 'reconciliation-required'
  return (
    <section
      aria-label={translate('components.native-chat.agentSwitch.contextReview', 'Context delivery')}
      className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground"
    >
      <p>
        {translate(
          'components.native-chat.agentSwitch.firstTurnDelivery',
          'Context is delivered with the first user turn. The selected agent is not active until delivery is confirmed. This does not transfer hidden provider state or prove the model understood the context.'
        )}
      </p>
      <p role={view.workspaceObservation === 'observed-change' ? 'status' : undefined}>
        {workspaceObservationLabel(view.workspaceObservation, effectsPossible)}
      </p>
      <p className="text-muted-foreground">
        {translate(
          'components.native-chat.agentSwitch.workspaceOtherWriters',
          'Other sessions, tools or users can still change files. Switching agents does not lock the workspace or roll back those edits.'
        )}
      </p>
      {view.target?.budget === 'unknown' ? (
        <p className="text-muted-foreground">
          {translate(
            'components.native-chat.agentSwitch.unknownBudget',
            'Native context capacity and occupancy are unknown. Full delivery cannot be promised.'
          )}
        </p>
      ) : null}
      {stale ? (
        <p role="status">
          {effectsPossible
            ? translate(
                'components.native-chat.agentSwitch.staleAfterDispatch',
                'Context or target changes were detected after delivery may have started. Reconcile the existing turn without resending it.'
              )
            : translate(
                'components.native-chat.agentSwitch.stalePreview',
                'The source or target changed. Review a refreshed preview before approving delivery.'
              )}
        </p>
      ) : null}
      {view.status === 'target-unavailable' ? (
        <p role="status">
          {translate(
            'components.native-chat.agentSwitch.targetUnavailable',
            'The selected agent is unavailable. No activation has been confirmed.'
          )}{' '}
          {translate(
            'components.native-chat.agentSwitch.selectExplicitExecutionSettings',
            'Select an available agent, an explicit model, and execution settings matching the native session before reviewing delivery.'
          )}
        </p>
      ) : null}
      {view.status === 'recipient-choice' && view.target ? (
        <p className="text-muted-foreground">
          {translate(
            'components.native-chat.agentSwitch.fullDeliveryUnavailable',
            'Verified full delivery is not available in this implementation. Review budgeted delivery instead.'
          )}
        </p>
      ) : null}
      {view.status === 'recipient-choice' && view.target ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled>
            {translate('components.native-chat.agentSwitch.reviewFull', 'Review full delivery')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onPolicy('budgeted')}>
            {translate(
              'components.native-chat.agentSwitch.reviewBudgeted',
              'Review budgeted delivery'
            )}
          </Button>
        </div>
      ) : null}
      {preview ? (
        <>
          <p>
            {translate(
              'components.native-chat.agentSwitch.sourceCount',
              'Source records: {{count}}',
              { count: preview.sourceCount }
            )}
          </p>
          <p>
            {preview.gapCountComplete && preview.gapCount !== null
              ? translate('components.native-chat.agentSwitch.gapCount', 'Known gaps: {{count}}', {
                  count: preview.gapCount
                })
              : translate(
                  'components.native-chat.agentSwitch.incompleteGapCount',
                  'Gap count is incomplete. Review the source evidence before approving.'
                )}
          </p>
          {preview.policy === 'budgeted' ? (
            <p>
              {translate(
                'components.native-chat.agentSwitch.projectionDisclosure',
                'This projection changes what is inline. Originals may be available through retrieval; they are not all delivered inline. Mandatory active constraints must remain inline.'
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onEvidence(view)}>
              {translate(
                'components.native-chat.agentSwitch.reviewEvidence',
                'Review transformations and omissions'
              )}
            </Button>
            {preview.policy === 'budgeted' && !preview.consented ? (
              <Button size="sm" disabled={busy} onClick={() => onApprove(view)}>
                {translate(
                  'components.native-chat.agentSwitch.approveProjection',
                  'Approve this projection'
                )}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}

function workspaceObservationLabel(
  status: ConversationPreparationView['workspaceObservation'],
  effectsPossible: boolean
): string {
  switch (status) {
    case 'observed-change':
      if (effectsPossible) {
        return translate(
          'components.native-chat.agentSwitch.workspaceChangedAfterDispatch',
          'Workspace changes were observed. They may include edits from the pending native turn; the watcher cannot identify who made them.'
        )
      }
      return translate(
        'components.native-chat.agentSwitch.workspaceChanged',
        'Workspace changes were observed after this preview was captured. Review refreshed context before proceeding.'
      )
    case 'no-change-observed':
      return translate(
        'components.native-chat.agentSwitch.workspaceNoChangeObserved',
        'No workspace change was observed during this preview.'
      )
    case undefined:
    case 'unknown':
      return translate(
        'components.native-chat.agentSwitch.workspaceObservationUnknown',
        'Workspace changes cannot be reliably observed here.'
      )
  }
}
