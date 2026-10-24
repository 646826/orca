import type {
  ConversationActivationResult,
  ConversationSourceBoundary,
  ConversationSwitchIntent
} from '../../../shared/conversation-record'
import type { ConversationStore } from './conversation-store'

export type ConversationSwitchPlan = {
  manifestId: string
  delivery: 'passive' | 'first-turn'
  sourceBoundaries: ConversationSourceBoundary[]
}
export type ConversationSwitchPreparation =
  | { kind: 'prepared'; plan: ConversationSwitchPlan }
  | { kind: 'waiting-consent' }
  | { kind: 'blocked'; reasons: readonly string[] }

export type ConversationSwitchDelivery =
  | {
      kind: 'accepted'
      receiptId: string
      candidateBoundary: ConversationSourceBoundary
    }
  | { kind: 'unknown' }
  | { kind: 'proven-no-effect' }

export type ConversationSwitchResult =
  | { kind: 'activated'; activation: ConversationActivationResult }
  | { kind: 'waiting-trigger' }
  | { kind: 'waiting-consent' }
  | { kind: 'blocked'; reasons: readonly string[] }
  | { kind: 'reconciliation-required' }
  | { kind: 'cancelled' }

export type ConversationSwitchPorts = {
  store: ConversationStore
  readSources(intent: ConversationSwitchIntent): ConversationSourceBoundary[]
  quiesce(
    intent: ConversationSwitchIntent,
    signal: AbortSignal
  ): Promise<{ kind: 'ready' } | { kind: 'blocked'; reasons: readonly string[] }>
  prepare(
    intent: ConversationSwitchIntent,
    previousManifestId: string | null,
    signal: AbortSignal
  ): Promise<ConversationSwitchPreparation>
  readPlan(manifestId: string): ConversationSwitchPlan | null
  reserveTrigger(
    intent: ConversationSwitchIntent,
    plan: ConversationSwitchPlan,
    signal: AbortSignal
  ): Promise<{ reservationId: string } | null>
  /** Implementations resolve durable plan/consent/reservation authority again before effects. */
  deliver(
    intent: ConversationSwitchIntent,
    plan: ConversationSwitchPlan,
    reservationId: string | null,
    signal: AbortSignal
  ): Promise<ConversationSwitchDelivery>
  /** Partial admission is unknown; accepted means the entire plan has a trusted receipt. */
  reconcile(
    intent: ConversationSwitchIntent,
    plan: ConversationSwitchPlan,
    signal: AbortSignal
  ): Promise<ConversationSwitchDelivery>
}
