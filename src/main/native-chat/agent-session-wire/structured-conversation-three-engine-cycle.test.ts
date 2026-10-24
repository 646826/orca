import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ConversationSwitchIntent } from '../../../shared/conversation-record'
import { readConversationManifest } from '../conversations/conversation-context-coverage'
import { conversationManifestSchema } from '../conversations/conversation-context-schema'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  opencodeRoundtripFixture,
  OPENCODE_ROUNDTRIP_MODELS
} from './structured-conversation-opencode-roundtrip.test-fixture'

it.each([
  ['claude', 'opencode'],
  ['opencode', 'claude']
] as const)(
  'runs Codex → %s → %s → retained Codex with real native inputs and continuation',
  async (first, second) => {
    const f = opencodeRoundtripFixture('OpenCode unique cycle response: 甲乙🙂')
    const original = 'Original three-engine constraint: preserve 最終条件🙂 and every file.'
    const advance = (intent: ConversationSwitchIntent) =>
      f.rpc('conversation.advance', {
        operationKey: intent.operationKey,
        expectedVersion: f.store.conversations.intent(intent.operationKey)!.version
      })
    const activate = async (intent: ConversationSwitchIntent, source: string, fresh: boolean) => {
      if (fresh) {
        await expect(advance(intent)).rejects.toThrow('Candidate native acquisition refused')
        const trust = f.host.deps.conversationEvidenceTrust!.read(intent.operationKey)!
        expect(
          await f.rpc('conversation.evidenceTrust', { operationKey: intent.operationKey })
        ).toMatchObject({ status: 'choice', choice: trust })
        await f.rpc('conversation.approveEvidenceTrust', {
          operationKey: intent.operationKey,
          choiceDigest: trust.choiceDigest
        })
        expect(await advance(intent)).toMatchObject({
          kind: 'blocked',
          reasons: ['recipient-approval-required']
        })
      }
      await vi.waitFor(
        () => {
          expect(
            f.host.readStatusSummary(intent.targetSessionId)?.hostExecutionPhase,
            JSON.stringify(f.diagnostic(intent.targetSessionId))
          ).toBe('ready')
          expect(
            f.host.deps.adapter.contextDeliveryCapabilities?.(intent.targetSessionId)
          ).toMatchObject({ state: 'verified' })
        },
        { timeout: 10000 }
      )
      expect(
        await f.sendRpc(
          source,
          `Switch from ${source} to ${intent.targetSessionId}; keep the complete response chain.`,
          true
        )
      ).toMatchObject({ ok: true })
      const targetProvider = f.store.getRecord(intent.targetSessionId)!.provider
      if (
        targetProvider !== 'codex' &&
        targetProvider !== 'claude' &&
        targetProvider !== 'opencode'
      ) {
        throw new Error(`Unexpected cycle provider: ${targetProvider}`)
      }
      const inputsBeforeApproval = f.inputs(targetProvider).length
      for (const policy of ['full', 'budgeted'] as const) {
        const view = f.host.deps.conversationPreparationControls!.read(intent.operationKey)!
        expect(
          await f.rpc('conversation.preparation', { operationKey: intent.operationKey })
        ).toEqual(view)
        expect(view.target, JSON.stringify(view)).toMatchObject({ budget: 'unknown' })
        await f.rpc('conversation.approveRecipient', {
          operationKey: intent.operationKey,
          expectedVersion: view.operationVersion,
          expectedContextGeneration: view.contextGeneration,
          expectedApprovalRevision: view.approvalRevision,
          targetBindingDigest: view.target!.bindingDigest,
          capabilityFingerprint: view.target!.capabilityFingerprint,
          policy,
          disclosure: 'available-canonical'
        })
        expect(await advance(intent)).toEqual(
          policy === 'full'
            ? { kind: 'blocked', reasons: ['unknown-budget'] }
            : { kind: 'waiting-consent' }
        )
        expect(f.inputs(targetProvider)).toHaveLength(inputsBeforeApproval)
      }
      const ready = f.host.deps.conversationPreparationControls!.read(intent.operationKey)!,
        preview = ready.preview!
      expect(preview.sourceCount).toBeGreaterThan(0)
      expect(preview).toMatchObject({
        policy: 'budgeted',
        inputEstimate: null,
        estimateConfidence: 'unknown',
        consented: false
      })
      const previewJson = f.db
        .prepare('SELECT manifest_json FROM conversation_preparation_previews WHERE manifest_id=?')
        .get(preview.manifestDigest)?.manifest_json
      if (typeof previewJson !== 'string') {
        throw new Error('Native cycle preview is unavailable')
      }
      expect(conversationManifestSchema.parse(JSON.parse(previewJson))).toMatchObject({
        budget: null,
        inputTokens: null,
        inputTokenConfidence: 'unknown'
      })
      await f.rpc('conversation.approveManifest', {
        operationKey: intent.operationKey,
        expectedVersion: ready.operationVersion,
        expectedContextGeneration: ready.contextGeneration,
        manifestDigest: preview.manifestDigest,
        targetBindingDigest: preview.targetBindingDigest,
        capabilityFingerprint: preview.capabilityFingerprint,
        transformationsDigest: preview.transformationsDigest,
        omissionsDigest: preview.omissionsDigest
      })
      expect(await advance(intent)).toMatchObject({ kind: 'activated' })
      expect(f.inputs(targetProvider)).toHaveLength(inputsBeforeApproval + 1)
      expect(f.store.conversations.route(intent.targetSessionId)).toMatchObject({ role: 'active' })
    }
    const found = (source: string, agent: 'claude' | 'opencode') =>
      f.foundTarget(source, `cycle-${agent}`, {
        provider: agent,
        agent,
        options: { model: OPENCODE_ROUNDTRIP_MODELS[agent] },
        accountHome:
          agent === 'claude'
            ? { variable: 'CLAUDE_CONFIG_DIR', path: join(f.directory, 'claude-home') }
            : { kind: 'opencode', locator: { kind: 'unmanaged' } }
      })
    try {
      await f.enrollSource({
        options: { model: OPENCODE_ROUNDTRIP_MODELS.codex },
        accountHome: { variable: 'CODEX_HOME', path: join(f.directory, 'codex-home') }
      })
      expect(await f.sendRpc(HOST_TEST_SESSION, original)).toMatchObject({ ok: true })
      await f.settle(HOST_TEST_SESSION, 1)
      const sourceNative = f.store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!
        .handle.nativeId
      const outward = await found(HOST_TEST_SESSION, first)
      await activate(outward, HOST_TEST_SESSION, true)
      await f.settle(`cycle-${first}`, 1)
      expect(JSON.stringify(f.inputs(first)[0]!.input)).toContain(original)
      const onward = await found(`cycle-${first}`, second)
      await activate(onward, `cycle-${first}`, true)
      await f.settle(`cycle-${second}`, 1)
      expect(JSON.stringify(f.inputs(second)[0]!.input)).toContain(original)
      expect(JSON.stringify(f.inputs(second)[0]!.input)).toContain(
        first === 'claude' ? 'Stub reply.' : 'OpenCode unique cycle response: 甲乙🙂'
      )
      const returning = await f.beginReturn(`cycle-${second}`, HOST_TEST_SESSION)
      await activate(returning, `cycle-${second}`, false)
      await f.settle(HOST_TEST_SESSION, 2)
      const returned = JSON.stringify(f.inputs('codex')[1]!.input)
      expect(returned).toContain('Stub reply.')
      expect(returned).toContain('OpenCode unique cycle response: 甲乙🙂')
      expect(JSON.stringify(f.inputs('codex')[0]!.input)).toContain(original)
      expect(returned).not.toContain(original)
      expect(
        f.store.getRecord(HOST_TEST_SESSION)!.providerHandleChain.at(-1)!.handle.nativeId
      ).toBe(sourceNative)
      expect(
        await f.sendRpc(
          HOST_TEST_SESSION,
          'Ordinary continuation after the complete three-engine cycle.'
        )
      ).toMatchObject({ ok: true })
      await f.settle(HOST_TEST_SESSION, 3)
      expect(f.inputs('codex')).toHaveLength(3)
      expect(f.inputs('claude')).toHaveLength(1)
      expect(f.inputs('opencode')).toHaveLength(1)
      expect(new Set(f.inputs('codex').map((row) => row.nativeId))).toEqual(new Set([sourceNative]))
      const inputs = [...f.inputs('codex'), ...f.inputs('claude'), ...f.inputs('opencode')]
      expect(
        new Set(inputs.map((row) => row.clientId ?? `${row.nativeId}:${row.requestId}`)).size
      ).toBe(5)
      expect(f.inputs('opencode')[0]!.requestId).toBeDefined()
      expect(f.opencodeObservations()).toContainEqual({
        kind: 'mcp-negotiated',
        methods: ['initialize', 'tools/list'],
        tools: ['orca_conversation_evidence']
      })
      const final = f.store.conversations.intent(returning.operationKey)!
      const manifest = readConversationManifest(f.db, final.manifestId!)!
      expect(
        manifest.projection.some((part) => part.representation === 'transport-projected')
      ).toBe(true)
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
  },
  30000
)
