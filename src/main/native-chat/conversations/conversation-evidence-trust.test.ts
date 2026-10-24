import { afterEach, beforeEach, expect, it } from 'vitest'
import { createConversationSwitchFixture } from './conversation-switch.fixture'
import {
  approveConversationEvidenceTrust,
  readConversationEvidenceTrustChoice,
  isConversationEvidenceTrustApproved,
  createConversationEvidenceTrustTablesSql
} from './conversation-evidence-trust'
let f: Awaited<ReturnType<typeof createConversationSwitchFixture>>
const readLaunch = () => ({
  transport: 'codex-dynamic-tool' as const,
  launchFingerprint: 'resolved-launch'
})
beforeEach(async () => {
  f = await createConversationSwitchFixture()
  f.host.db.exec(createConversationEvidenceTrustTablesSql())
})
afterEach(() => f.close())
it('requires explicit approval of the exact server-derived launch and tool scope before acquisition', () => {
  const choice = readConversationEvidenceTrustChoice(f.host.db, f.operationKey, readLaunch)
  expect(isConversationEvidenceTrustApproved(f.host.db, choice)).toBe(false)
  approveConversationEvidenceTrust(
    f.host.db,
    {
      operationKey: f.operationKey,
      choiceDigest: choice.choiceDigest,
      callerKey: 'reviewing-client',
      now: 1
    },
    readLaunch
  )
  expect(isConversationEvidenceTrustApproved(f.host.db, choice)).toBe(true)
  expect(() =>
    approveConversationEvidenceTrust(
      f.host.db,
      {
        operationKey: f.operationKey,
        choiceDigest: choice.choiceDigest,
        callerKey: 'reviewing-client',
        now: 2
      },
      () => ({ ...readLaunch(), launchFingerprint: 'different-launch' })
    )
  ).toThrow()
})
it('invalidates trust after context clear, cancellation or explicit revocation', () => {
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
  f.host.db.prepare('DELETE FROM conversation_evidence_tool_trust').run()
  expect(isConversationEvidenceTrustApproved(f.host.db, choice)).toBe(false)
  approveConversationEvidenceTrust(
    f.host.db,
    {
      operationKey: f.operationKey,
      choiceDigest: choice.choiceDigest,
      callerKey: 'client',
      now: 2
    },
    readLaunch
  )
  f.host.db
    .prepare("UPDATE conversations SET record_json=json_set(record_json,'$.contextGeneration',2)")
    .run()
  expect(isConversationEvidenceTrustApproved(f.host.db, choice)).toBe(false)
})
it.each(['nativeBindingGeneration', 'candidateSegmentId', 'activationFence'] as const)(
  'rejects changed %s in the approved candidate scope',
  (field) => {
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
    if (field === 'nativeBindingGeneration') {
      f.host.db
        .prepare(
          "UPDATE conversation_participants SET record_json=json_set(record_json,'$.nativeBindingGeneration',2) WHERE session_id='session-b'"
        )
        .run()
    } else if (field === 'candidateSegmentId') {
      f.host.db
        .prepare(
          "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.candidateSegmentId','changed') WHERE operation_key=?"
        )
        .run(f.operationKey)
    } else {
      f.host.db
        .prepare(
          "UPDATE conversation_switch_intents SET record_json=json_set(record_json,'$.activationFence',99) WHERE operation_key=?"
        )
        .run(f.operationKey)
    }
    expect(isConversationEvidenceTrustApproved(f.host.db, choice)).toBe(false)
  }
)
