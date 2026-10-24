import { createHash } from 'node:crypto'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type {
  ConversationContextManifest,
  ConversationProjectionConsent
} from '../../../shared/conversation-handoff'

export function conversationContextDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}
export function consentForConversationManifest(
  manifest: ConversationContextManifest,
  approvedBy: string
): ConversationProjectionConsent {
  if (approvedBy.length === 0) {
    throw new Error('Context consent requires an approving caller')
  }
  return {
    manifestDigest: manifest.digest,
    targetBindingDigest: manifest.targetBindingDigest,
    capabilityFingerprint: manifest.target.capabilityFingerprint,
    transformationsDigest: manifest.transformationsDigest,
    omissionsDigest: manifest.omissionsDigest,
    approvedBy
  }
}
export function conversationManifestIntegrity(manifest: ConversationContextManifest): boolean {
  const { manifestId, digest, ...body } = manifest
  return manifestId === digest && conversationContextDigest(body) === digest
}
export function validateConversationConsent(
  manifest: ConversationContextManifest,
  consent: ConversationProjectionConsent | null
): boolean {
  if (!conversationManifestIntegrity(manifest)) {
    return false
  }
  if (manifest.policy !== 'budgeted') {
    return true
  }
  return (
    consent !== null &&
    consent.approvedBy.length > 0 &&
    consent.manifestDigest === manifest.digest &&
    consent.targetBindingDigest === manifest.targetBindingDigest &&
    consent.capabilityFingerprint === manifest.target.capabilityFingerprint &&
    consent.transformationsDigest === manifest.transformationsDigest &&
    consent.omissionsDigest === manifest.omissionsDigest
  )
}
