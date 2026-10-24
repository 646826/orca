import { NativeChatTransferRecoveryPanel } from './NativeChatTransferRecoveryPanel'
import type { ConversationEvidenceGap } from '../../../../shared/conversation-handoff'
import { nativeChatPermissionModeLabel } from './native-chat-permission-mode-labels'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationSurfaceSnapshot } from '../../../../shared/conversation-surface-rpc'
import type { useNativeChatConversationControls } from './use-native-chat-conversation-controls'
import { NativeChatConversationPreview } from './NativeChatConversationPreview'

export function NativeChatConversationControlsPanel({
  snapshot,
  controls,
  onRebuild
}: {
  snapshot: ConversationSurfaceSnapshot
  controls: ReturnType<typeof useNativeChatConversationControls>
  onRebuild?: () => void
}): React.JSX.Element | null {
  const operation = snapshot.operation
  const target = snapshot.selected
  if (!operation || !target || operation.phase === 'activated' || operation.phase === 'cancelled') {
    return <NativeChatTransferRecoveryPanel controls={controls} />
  }
  const uncertain = operation.phase === 'reconciliation-required'
  const canCancel = operation.phase === 'quiescing' || operation.phase === 'prepared'
  return (
    <div className="space-y-2">
      <NativeChatTransferRecoveryPanel controls={controls} />
      <div className="space-y-1 rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
        <p>
          {translate('components.native-chat.agentSwitch.recipient', 'Selected agent: {{agent}}', {
            agent: target.agentLabel
          })}
        </p>
        <p>
          {translate(
            'components.native-chat.agentSwitch.hostWorkspace',
            'Host: {{host}} · Workspace: {{workspace}}',
            { host: target.host.label, workspace: target.workspace.label }
          )}
        </p>
        <p>
          {target.profile.state === 'configured'
            ? translate(
                'components.native-chat.agentSwitch.configuredProfile',
                'Configured profile: {{profile}}',
                { profile: target.profile.label }
              )
            : translate(
                'components.native-chat.agentSwitch.unknownProfile',
                'Configured profile identity is unknown.'
              )}
        </p>
        <p className="text-muted-foreground">
          {translate(
            'components.native-chat.agentSwitch.loginUnverified',
            'The authenticated provider account has not been verified by this preview.'
          )}
        </p>
        <p>
          {target.permissions.state === 'confirmed'
            ? translate(
                'components.native-chat.agentSwitch.permissionConfirmed',
                'Native permission mode: {{mode}}',
                {
                  mode: target.permissions.applied
                    ? nativeChatPermissionModeLabel(target.permissions.applied)
                    : translate('components.native-chat.agentSwitch.permissionUnknown', 'Unknown')
                }
              )
            : translate(
                'components.native-chat.agentSwitch.permissionUnverified',
                'Native permission enforcement is not yet confirmed. Historical approvals do not authorize new actions.'
              )}
        </p>
      </div>
      {controls.preparation ? (
        <NativeChatConversationPreview
          view={controls.preparation}
          busy={controls.busy}
          onPolicy={(policy) => {
            void controls.approvePolicy(policy)
          }}
          onApprove={(view) => {
            void controls.approveManifest(view)
          }}
          onEvidence={(view) => {
            void controls.readEvidence(view)
          }}
        />
      ) : null}
      {controls.trust && target.startupTrust !== 'approved' ? (
        <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
          <p>
            {translate(
              'components.native-chat.agentSwitch.startupTrustDisclosure',
              'Starting this native agent can run workspace hooks, MCP servers and configured tools with its existing permissions. The evidence reader does not sandbox that startup.'
            )}
          </p>
          <Button
            size="sm"
            disabled={controls.busy}
            onClick={() => {
              void controls.approveTrust()
            }}
          >
            {translate(
              'components.native-chat.agentSwitch.approveStartup',
              'Approve this native startup'
            )}
          </Button>
        </div>
      ) : null}
      {controls.evidence ? (
        <div className="space-y-2 rounded-md border border-border bg-card p-3 text-xs text-card-foreground">
          <p>
            {translate(
              'components.native-chat.agentSwitch.evidencePage',
              'Evidence representations in this page: {{count}}',
              { count: controls.evidence.entries.length }
            )}
          </p>
          <EvidenceGaps gaps={controls.evidence.manifestGaps} />
          <ul className="space-y-1">
            {controls.evidence.entries.map((entry) => (
              <li key={entry.ordinal} className="break-words">
                <span>
                  {entry.version.source.sessionId} · {entry.version.source.epoch} ·{' '}
                  {entry.version.source.sequence}
                </span>
                <span> — {representationLabel(entry.representation)}</span>
                {entry.transformedText ? (
                  <pre className="whitespace-pre-wrap break-words text-xs">
                    {entry.transformedText}
                  </pre>
                ) : null}
                <EvidenceGaps gaps={entry.gaps} />
              </li>
            ))}
          </ul>
          {controls.evidence.next !== null && controls.preparation ? (
            <Button
              size="sm"
              variant="outline"
              disabled={controls.busy}
              onClick={() => {
                if (controls.preparation && controls.evidence?.next !== null) {
                  void controls.readEvidence(controls.preparation, controls.evidence?.next ?? 0)
                }
              }}
            >
              {translate(
                'components.native-chat.agentSwitch.nextEvidencePage',
                'Next evidence page'
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={controls.busy || operation.phase === 'delivering'}
          onClick={() => {
            void controls.advance()
          }}
        >
          {uncertain
            ? translate('components.native-chat.agentSwitch.reconcile', 'Reconcile this switch')
            : translate('components.native-chat.agentSwitch.continue', 'Continue switch')}
        </Button>
        {onRebuild ? (
          <Button
            size="sm"
            variant="outline"
            disabled={controls.busy || !canCancel}
            onClick={onRebuild}
          >
            {translate(
              'components.native-chat.agentSwitch.rebuildNative',
              'Rebuild selected native session with conversation context'
            )}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={controls.busy || !canCancel}
          onClick={() => {
            void controls.cancel()
          }}
        >
          {translate('components.native-chat.agentSwitch.cancel', 'Cancel switch')}
        </Button>
      </div>
    </div>
  )
}
function representationLabel(value: string): string {
  switch (value) {
    case 'exact':
      return translate('components.native-chat.agentSwitch.representationExact', 'Exact')
    case 'transport-projected':
      return translate(
        'components.native-chat.agentSwitch.representationTransportProjected',
        'Authenticated transport wrapper removed; original user text retained'
      )
    case 'summarized':
      return translate('components.native-chat.agentSwitch.representationSummarized', 'Summarized')
    case 'retrievable-only':
      return translate(
        'components.native-chat.agentSwitch.representationRetrieval',
        'Available through retrieval only'
      )
    default:
      return translate('components.native-chat.agentSwitch.representationMissing', 'Missing')
  }
}

function EvidenceGaps({ gaps }: { gaps: ConversationEvidenceGap[] }): React.JSX.Element | null {
  if (!gaps.length) {
    return null
  }
  const uniqueGaps = new Map(
    gaps.map((gap) => [
      JSON.stringify([
        gap.source.sessionId,
        gap.source.epoch,
        gap.source.sequence,
        gap.source.itemId,
        gap.source.itemRevision,
        gap.source.batchIndex,
        gap.reason,
        gap.critical
      ]),
      gap
    ])
  )
  return (
    <ul className="space-y-1 text-muted-foreground">
      {Array.from(uniqueGaps, ([key, gap]) => (
        <li key={key}>
          {gapReasonLabel(gap.reason)}
          {gap.critical ? (
            <>
              {' '}
              ·{' '}
              {translate(
                'components.native-chat.agentSwitch.gapCritical',
                'Critical input: required content must be inline before strict handoff.'
              )}{' '}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
function gapReasonLabel(reason: ConversationEvidenceGap['reason']): string {
  switch (reason) {
    case 'captured-incomplete':
      return translate(
        'components.native-chat.agentSwitch.gapCaptureIncomplete',
        'Capture was incomplete; uncaptured bytes are unavailable.'
      )
    case 'legacy-bounded':
      return translate(
        'components.native-chat.agentSwitch.gapLegacyBounded',
        'Previously bounded source; omitted original bytes are unavailable.'
      )
    case 'missing-artifact':
      return translate(
        'components.native-chat.agentSwitch.gapMissingArtifact',
        'The referenced artifact is missing.'
      )
    case 'changed-artifact':
      return translate(
        'components.native-chat.agentSwitch.gapChangedArtifact',
        'The artifact changed and no longer matches the preserved source.'
      )
    case 'corrupt-source':
      return translate(
        'components.native-chat.agentSwitch.gapCorruptSource',
        'Source integrity could not be verified.'
      )
    case 'newer-schema':
      return translate(
        'components.native-chat.agentSwitch.gapNewerSchema',
        'This source needs a newer reader version.'
      )
    case 'unsupported-format':
      return translate(
        'components.native-chat.agentSwitch.gapUnsupportedFormat',
        'The selected agent does not support this source format.'
      )
    case 'excluded':
      return translate(
        'components.native-chat.agentSwitch.gapExcluded',
        'Excluded by disclosure policy; content is not shown or delivered.'
      )
  }
}
