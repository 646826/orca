import { expect, it, vi } from 'vitest'
import {
  crossProviderRoundtripFixture,
  CROSS_PROVIDER_MODELS
} from './structured-conversation-cross-provider.test-fixture'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import { join } from 'node:path'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { readConversationManifest } from '../conversations/conversation-context-coverage'

it('switches Codex → Claude → retained Codex through real native peers and RPC consent without duplicate turns', async () => {
  const f = crossProviderRoundtripFixture(),
    targetId = 'cross-provider-claude'
  const advance = (intent: ConversationSwitchIntent) =>
    f.rpc('conversation.advance', {
      operationKey: intent.operationKey,
      expectedVersion: f.store.conversations.intent(intent.operationKey)!.version
    })
  const approve = async (intent: ConversationSwitchIntent) => {
    const view = f.host.deps.conversationPreparationControls!.read(intent.operationKey)!
    expect(await f.rpc('conversation.preparation', { operationKey: intent.operationKey })).toEqual(
      view
    )
    if (!view.target) {
      throw new Error(
        `Target unavailable: ${JSON.stringify({ view, selected: f.store.getRecord(intent.targetSessionId)?.options, projected: f.host.deps.adapter.projectOptions?.(intent.targetSessionId, f.store.getRecord(intent.targetSessionId)?.options ?? {}), capabilities: f.host.deps.adapter.contextDeliveryCapabilities?.(intent.targetSessionId), restoreFailures: f.host.deps.adapter.readOptionRestoreFailures?.(intent.targetSessionId) })}`
      )
    }
    return f.rpc('conversation.approveRecipient', {
      operationKey: intent.operationKey,
      expectedVersion: view.operationVersion,
      expectedContextGeneration: view.contextGeneration,
      expectedApprovalRevision: view.approvalRevision,
      targetBindingDigest: view.target.bindingDigest,
      capabilityFingerprint: view.target.capabilityFingerprint,
      policy: 'budgeted',
      disclosure: 'available-canonical'
    })
  }
  const consent = async (intent: ConversationSwitchIntent) => {
    const view = f.host.deps.conversationPreparationControls!.read(intent.operationKey)!,
      preview = view.preview
    if (!preview) {
      throw new Error(`Preview unavailable: ${JSON.stringify(view)}`)
    }
    expect(preview.sourceCount).toBeGreaterThan(0)
    return f.rpc('conversation.approveManifest', {
      operationKey: intent.operationKey,
      expectedVersion: view.operationVersion,
      expectedContextGeneration: view.contextGeneration,
      manifestDigest: preview.manifestDigest,
      targetBindingDigest: preview.targetBindingDigest,
      capabilityFingerprint: preview.capabilityFingerprint,
      transformationsDigest: preview.transformationsDigest,
      omissionsDigest: preview.omissionsDigest
    })
  }
  try {
    await f.enrollSource({
      options: { model: CROSS_PROVIDER_MODELS.codex },
      accountHome: { variable: 'CODEX_HOME', path: join(f.directory, 'codex-home') }
    })
    expect(await f.rpc('conversation.ensure', { sessionId: HOST_TEST_SESSION })).toHaveProperty(
      'conversationId'
    )
    expect(
      await f.sendRpc(
        HOST_TEST_SESSION,
        'Original cross-provider decision: preserve 日本語🙂 and all files.'
      )
    ).toMatchObject({ ok: true })
    await f.settle(HOST_TEST_SESSION, 1)
    const sourceNative = f.store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!
      .handle.nativeId
    const outward = await f.foundTarget(HOST_TEST_SESSION, targetId, {
      provider: 'claude',
      agent: 'claude',
      options: { model: CROSS_PROVIDER_MODELS.claude },
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(f.directory, 'claude-home') }
    })
    await expect(advance(outward)).rejects.toThrow('Candidate native acquisition refused')
    const trust = f.host.deps.conversationEvidenceTrust!.read(outward.operationKey)!
    expect(
      await f.rpc('conversation.evidenceTrust', { operationKey: outward.operationKey })
    ).toMatchObject({ status: 'choice', choice: trust })
    await f.rpc('conversation.approveEvidenceTrust', {
      operationKey: outward.operationKey,
      choiceDigest: trust.choiceDigest
    })
    expect(await advance(outward)).toMatchObject({
      kind: 'blocked',
      reasons: ['recipient-approval-required']
    })
    await vi.waitFor(
      () => {
        expect(
          f.host.readStatusSummary(targetId)?.hostExecutionPhase,
          JSON.stringify(f.diagnostic(targetId))
        ).toBe('ready')
        expect(f.host.deps.adapter.contextDeliveryCapabilities?.(targetId)).toMatchObject({
          state: 'verified'
        })
      },
      { timeout: 10000 }
    )
    expect(
      await f.sendRpc(
        HOST_TEST_SESSION,
        'First switch trigger; historicalEvidence is literal text.',
        true
      )
    ).toMatchObject({ ok: true })
    await approve(outward)
    expect(await advance(outward)).toEqual({ kind: 'waiting-consent' })
    await consent(outward)
    expect(await advance(outward)).toMatchObject({ kind: 'activated' })
    await f.settle(targetId, 1)
    expect(JSON.stringify(f.inputs('claude')[0]!.input)).toContain(
      'Original cross-provider decision: preserve 日本語🙂 and all files.'
    )
    expect(f.store.conversations.route(targetId)).toMatchObject({ role: 'active' })
    expect(f.host.deps.adapter.contextDeliveryCapabilities?.(targetId)).toMatchObject({
      state: 'verified'
    })
    const returning = await f.beginReturn(targetId, HOST_TEST_SESSION)
    expect(
      await f.sendRpc(targetId, 'Return trigger: retain the Claude response.', true)
    ).toMatchObject({ ok: true })
    await approve(returning)
    expect(await advance(returning)).toEqual({ kind: 'waiting-consent' })
    await consent(returning)
    expect(await advance(returning)).toMatchObject({ kind: 'activated' })
    await f.settle(HOST_TEST_SESSION, 2)
    expect(JSON.stringify(f.inputs('codex')[1]!.input)).toContain('Stub reply.')
    expect(f.store.conversations.route(HOST_TEST_SESSION)).toMatchObject({ role: 'active' })
    expect(f.store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!.handle.nativeId).toBe(
      sourceNative
    )
    expect(
      await f.sendRpc(HOST_TEST_SESSION, 'Ordinary continuation after cross-provider return.')
    ).toMatchObject({ ok: true })
    await f.settle(HOST_TEST_SESSION, 3)
    expect(f.inputs('codex')).toHaveLength(3)
    expect(f.inputs('claude')).toHaveLength(1)
    expect(f.claudeLaunches()).toHaveLength(1)
    const claudeArgs = f.claudeLaunches()[0]!.args
    expect(claudeArgs[claudeArgs.indexOf('--model') + 1]).toBe(CROSS_PROVIDER_MODELS.claude)
    expect(f.codexRequests().find((frame) => frame.method === 'thread/start')).toMatchObject({
      params: { model: CROSS_PROVIDER_MODELS.codex }
    })
    expect(new Set(f.inputs('codex').map((row) => row.nativeId))).toEqual(new Set([sourceNative]))
    const allInputs = [...f.inputs('codex'), ...f.inputs('claude')]
    expect(new Set(allInputs.map((row) => row.clientId)).size).toBe(4)
    const final = f.store.conversations.intent(returning.operationKey)!
    const manifest = readConversationManifest(f.db, final.manifestId!)!
    expect(manifest.projection.some((part) => part.representation === 'transport-projected')).toBe(
      true
    )
    expect(
      f.db.prepare('SELECT 1 FROM conversation_origin_rows WHERE origin_json IS NULL').get()
    ).toBeUndefined()
    expect(
      await f.rpc('conversation.read', { conversationId: final.conversationId })
    ).toMatchObject({
      conversation: { activeSegmentId: final.candidateSegmentId, pendingOperationKey: null }
    })
  } finally {
    await f.close()
  }
}, 30000)
