import type { ConversationDeliveryHost } from './conversation-delivery-plan'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import { createConversationEvidenceRegistry } from './conversation-evidence-registry'
import {
  approveConversationEvidenceTrust,
  readConversationEvidenceTrustChoice
} from './conversation-evidence-trust'
import type { ConversationEvidenceNativeOwner } from './conversation-evidence-registry'
let f: Awaited<ReturnType<typeof createConversationSwitchFixture>>
let owner: ConversationEvidenceNativeOwner | null
const readLaunch = () => ({ transport: 'codex-dynamic-tool' as const, launchFingerprint: 'launch' })
beforeEach(async () => {
  f = await createConversationSwitchFixture()
  owner = {
    nativeSessionId: 'native',
    acquisitionGeneration: 'acquisition',
    runtimeFence: 1,
    baseCapabilityFingerprint: 'base',
    launchFingerprint: 'launch',
    transport: 'codex-dynamic-tool'
  }
})
afterEach(() => f.close())
function registry() {
  return createConversationEvidenceRegistry({
    db: f.host.db,
    stateDirectory: f.host.stateDirectory,
    readLaunch,
    readNative: () => owner,
    deliveryHost: () => null
  })
}
function approve() {
  const choice = readConversationEvidenceTrustChoice(f.host.db, f.operationKey, readLaunch)
  approveConversationEvidenceTrust(
    f.host.db,
    {
      operationKey: f.operationKey,
      choiceDigest: choice.choiceDigest,
      callerKey: 'client',
      now: 1
    },
    readLaunch
  )
}
it('remains unavailable until explicit startup approval and actual registration confirmation', async () => {
  const r = registry()
  expect(r.prepare('session-b', false).kind).toBe('startup-trust-required')
  approve()
  const pending = r.prepare('session-b', false)
  expect(pending.kind).toBe('pending')
  if (pending.kind !== 'pending' || !owner) {
    throw new Error('missing pending registration')
  }
  expect(r.readRegistration('session-b')).toBeNull()
  pending.confirm(owner)
  const ready = r.readRegistration('session-b')
  expect(ready?.protocol).toBe('orca-evidence-v1')
  expect(ready?.capabilityFingerprint).not.toBe(owner.baseCapabilityFingerprint)
  await expect(pending.invoke({ action: 'list' }, new AbortController().signal)).rejects.toThrow()
  await r.close('session-b')
  expect(r.readRegistration('session-b')).toBeNull()
})
it('requires explicit native rebuild for an unregistered retained Codex thread', () => {
  approve()
  expect(registry().prepare('session-b', true).kind).toBe('native-rebuild-required')
})
it.each(['launch', 'capability', 'acquisition', 'trust'] as const)(
  'revokes registration on %s changes',
  async (change) => {
    approve()
    const r = registry(),
      p = r.prepare('session-b', false)
    if (p.kind !== 'pending' || !owner) {
      throw new Error('missing pending')
    }
    p.confirm(owner)
    expect(r.readRegistration('session-b')).not.toBeNull()
    if (change === 'launch') {
      owner = { ...owner, launchFingerprint: 'other' }
    }
    if (change === 'capability') {
      owner = { ...owner, baseCapabilityFingerprint: 'changed-model' }
    }
    if (change === 'acquisition') {
      owner = { ...owner, acquisitionGeneration: 'replaced' }
    }
    if (change === 'trust') {
      f.host.db.prepare('DELETE FROM conversation_evidence_tool_trust').run()
    }
    expect(r.readRegistration('session-b')).toBeNull()
    await r.close('session-b')
  }
)

it('distinguishes a pending registration from a revoked one without creating a second tool', () => {
  approve()
  const r = registry()
  expect(r.prepare('session-b', false).kind).toBe('pending')
  expect(r.prepare('session-b', false).kind).toBe('registration-pending')
})
it('releases revoked registration slots without an explicit close', async () => {
  approve()
  const r = registry(),
    p = r.prepare('session-b', false)
  if (p.kind !== 'pending' || !owner) {
    throw new Error('missing pending')
  }
  p.confirm(owner)
  expect(r.readRegistration('session-b')).not.toBeNull()
  owner = { ...owner, acquisitionGeneration: 'new' }
  expect(r.readRegistration('session-b')).toBeNull()
  await Promise.resolve()
  await Promise.resolve()
  expect(r.prepare('session-b', false).kind).toBe('pending')
})
it('does not install a plan after close races the asynchronous binding boundary', async () => {
  const { createConversationEvidenceFixture } =
    await import('./conversation-evidence-reader.test-fixture')
  let r: ReturnType<typeof createConversationEvidenceRegistry> | undefined
  let delivery: ConversationDeliveryHost | null = null
  const evidence = await createConversationEvidenceFixture(false, 0, (fixture, target) => {
    const actualOwner: ConversationEvidenceNativeOwner = {
      nativeSessionId: 'native-thread',
      acquisitionGeneration: 'acquired',
      runtimeFence: 1,
      baseCapabilityFingerprint: 'base',
      launchFingerprint: 'launch',
      transport: 'codex-dynamic-tool'
    }
    r = createConversationEvidenceRegistry({
      db: fixture.host.db,
      stateDirectory: fixture.host.stateDirectory,
      readLaunch,
      readNative: () => actualOwner,
      deliveryHost: () => delivery
    })
    const choice = readConversationEvidenceTrustChoice(
      fixture.host.db,
      fixture.operationKey,
      readLaunch
    )
    approveConversationEvidenceTrust(
      fixture.host.db,
      {
        operationKey: fixture.operationKey,
        choiceDigest: choice.choiceDigest,
        callerKey: 'client',
        now: 1
      },
      readLaunch
    )
    const pending = r.prepare('session-b', false)
    if (pending.kind !== 'pending') {
      throw new Error('missing registration')
    }
    pending.confirm(actualOwner)
    const registration = r.readRegistration('session-b')
    if (!registration) {
      throw new Error('missing registration')
    }
    return { ...target, capabilityFingerprint: registration.capabilityFingerprint }
  })
  try {
    delivery = evidence.authority
    evidence.bind()
    if (!r) {
      throw new Error('missing registry')
    }
    const binding = r.bindPlan('session-b', evidence.plan.planId)
    const closing = r.close('session-b')
    await expect(binding).rejects.toThrow()
    await closing
  } finally {
    await r?.close('session-b')
    evidence.fixture.close()
  }
})
it('promotes actual transport confirmation only after matching host publication', async () => {
  approve()
  const r = registry(),
    p = r.prepare('session-b', false)
  if (p.kind !== 'pending' || !owner) {
    throw new Error('missing pending')
  }
  const confirmed = owner
  owner = null
  p.confirm(confirmed)
  expect(r.readRegistration('session-b')).toBeNull()
  owner = { ...confirmed, acquisitionGeneration: 'other' }
  expect(r.readRegistration('session-b')).toBeNull()
  owner = confirmed
  expect(r.readRegistration('session-b')).not.toBeNull()
  owner = { ...confirmed, acquisitionGeneration: 'replaced' }
  expect(r.readRegistration('session-b')).toBeNull()
  await r.close('session-b')
})
it('cannot promote a pending native confirmation after acquisition cancellation', async () => {
  approve()
  const r = registry(),
    controller = new AbortController()
  const p = r.prepare('session-b', false, { signal: controller.signal })
  if (p.kind !== 'pending' || !owner) {
    throw new Error('missing pending')
  }
  const confirmed = owner
  owner = null
  p.confirm(confirmed)
  controller.abort()
  owner = confirmed
  expect(r.readRegistration('session-b')).toBeNull()
  await r.close('session-b')
})
