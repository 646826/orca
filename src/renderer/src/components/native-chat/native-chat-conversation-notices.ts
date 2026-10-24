import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { translate } from '@/i18n/i18n'
import type { ConversationOperationView } from '../../../../shared/conversation-rpc'
import type { ConversationRpcRefusalReason } from '../../../../shared/conversation-rpc-refusal'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export function nativeChatConversationNotice(
  intent: ConversationOperationView | null,
  refusal?: { reason: ConversationRpcRefusalReason; errorText?: string }
): NativeChatComposerNotice | null {
  if (refusal) {
    return {
      key: 'conversation-switch-refusal',
      kind: 'error',
      text: refusalHeadline(refusal.reason),
      ...(refusal.errorText ? { errorText: refusal.errorText } : {})
    }
  }
  if (!intent || intent.phase === 'activated' || intent.phase === 'cancelled') {
    return null
  }
  return {
    key: 'conversation-switch-status',
    kind: 'host',
    tone: intent.phase === 'reconciliation-required' ? 'warning' : 'muted',
    text: phaseHeadline(intent.phase)
  }
}
function phaseHeadline(phase: ConversationOperationView['phase']): string {
  switch (phase) {
    case 'quiescing':
      return translate(
        'components.native-chat.agentSwitch.quiescing',
        'Waiting for admitted sends, tools and approvals to settle. New sends are queued; Stop and pending approval responses remain available.'
      )
    case 'prepared':
      return translate(
        'components.native-chat.agentSwitch.prepared',
        'Context is prepared. The selected agent is waiting for confirmed delivery before becoming active.'
      )
    case 'delivering':
      return translate(
        'components.native-chat.agentSwitch.delivering',
        'Delivery is pending. The selected agent is not yet active; additional sends remain queued.'
      )
    case 'reconciliation-required':
      return translate(
        'components.native-chat.agentSwitch.reconciliationRequired',
        'Delivery or an external effect has an unknown outcome. Do not resend the triggering message; reconcile this operation before continuing.'
      )
    case 'activated':
    case 'cancelled':
      return ''
  }
}
function refusalHeadline(reason: unknown): string {
  switch (reason) {
    case 'trust-required':
      return translate(
        'components.native-chat.agentSwitch.trustRequired',
        'Review the selected native runtime and its startup behavior before continuing. Read-only evidence access does not sandbox hooks or other tools.'
      )
    case 'native-rebuild-required':
      return translate(
        'components.native-chat.agentSwitch.rebuildRequired',
        'This native session cannot safely accept the handoff. Review a fresh native session with preserved conversation context.'
      )
    case 'stale-preview':
    case 'stale-source':
    case 'stale-generation':
      return translate(
        'components.native-chat.agentSwitch.changedBeforeApproval',
        'The conversation or selected target changed. Refresh and review the current delivery choice.'
      )
    case 'unverified-delivery':
      return translate(
        'components.native-chat.agentSwitch.unverifiedDelivery',
        'Native acceptance is unverified. Reconcile the existing operation before sending again.'
      )
    case 'unsupported':
      return translate(
        'components.native-chat.agentSwitch.unsupported',
        'This host or native runtime does not support the required conversation-switching capabilities.'
      )
    case 'resource-limit':
      return translate(
        'components.native-chat.agentSwitch.resourceLimit',
        'The available delivery budget or storage limit cannot accommodate this context. No silent truncation was applied.'
      )
    default:
      return translate(
        'components.native-chat.agentSwitch.refused',
        'Orca could not safely continue this switch. Refresh the conversation to review its current state.'
      )
  }
}

export function nativeChatConversationRequestFailure(cause: unknown): NativeChatComposerNotice {
  const data = cause instanceof RuntimeRpcCallError ? cause.response.error.data : null
  const detail =
    data && typeof data === 'object' && 'errorText' in data && typeof data.errorText === 'string'
      ? data.errorText
      : undefined
  return {
    key: 'conversation-switch-request',
    kind: 'error',
    text:
      data && typeof data === 'object' && 'reason' in data
        ? refusalHeadline(data.reason)
        : translate(
            'components.native-chat.agentSwitch.requestFailed',
            'The switch request did not complete successfully. Refresh its state before trying again; an unanswered request may already have reached the host.'
          ),
    ...(detail ? { errorText: detail } : {})
  }
}
