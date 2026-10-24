import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquiredCodexAdapter,
  fakeCodexAppServer
} from '../../codex/codex-structured-dispatch-test-support'
import {
  acquired,
  fakeClaude,
  claudeOpened,
  USER_MESSAGE,
  PROVIDER_SESSION_ID,
  adapterAtPublishFor,
  identityFor
} from '../../claude/claude-structured-session-test-support'
import { openAcpAdapterRig } from '../../acp/acp-structured-adapter.test-support'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import {
  SESSION,
  closeProviderTimelineRigs
} from '../agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

describe('live native context delivery capability contracts', () => {
  it('refuses unknown native versions instead of using a numerical floor', async () => {
    const codex = fakeCodexAppServer({ initialize: () => ({ userAgent: 'codex_cli_rs/99.0.0' }) })
    const codexAdapter = await acquiredCodexAdapter({ codex, settlements: [] })
    expect(codexAdapter.contextDeliveryCapabilities('session-1')).toEqual({ state: 'unverified' })
    const claudeAdapter = await acquired(fakeClaude())
    await claudeOpened(claudeAdapter, 'session-1')
    expect(claudeAdapter.contextDeliveryCapabilities('session-1')).toEqual({ state: 'unverified' })
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode')!,
      initialize: { agentInfo: { name: 'OpenCode', version: '99.0.0' } }
    })
    await rig.acquire()
    expect(rig.adapter.contextDeliveryCapabilities(SESSION)).toEqual({ state: 'unverified' })
  })
  it('binds Codex initialize contract to live thread and invalidates on death', async () => {
    const codex = fakeCodexAppServer({
      initialize: () => ({
        userAgent: 'codex_cli_rs/0.159.0-alpha.3',
        platformFamily: 'unix',
        platformOs: 'linux',
        codexHome: '/synthetic'
      })
    })
    const adapter = await acquiredCodexAdapter({ codex, settlements: [] })
    expect(adapter.contextDeliveryCapabilities('session-1')).toMatchObject({
      state: 'verified',
      firstTurnReceipt: 'live-acceptance'
    })
    const before = adapter.contextDeliveryCapabilities('session-1')
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'model',
      value: 'changed-model'
    })
    expect(adapter.contextDeliveryCapabilities('session-1')).not.toEqual(before)
    codex.connections[0].closed = true
    expect(adapter.contextDeliveryCapabilities('session-1')).toEqual({ state: 'unverified' })
  })
  it('allows no-hook Claude only after its control initialization without a model turn', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const adapter = adapterAtPublishFor(claude, { contextDeliveryVersion: '2.1.309' })
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'capability-test' })
    expect(adapter.contextDeliveryCapabilities('session-1')).toEqual({ state: 'unverified' })
    await claudeOpened(adapter, 'session-1')
    expect(claude.connections[0].sent).toHaveLength(0)
    expect(adapter.contextDeliveryCapabilities('session-1')).toMatchObject({ state: 'verified' })
  })
  it('keeps the prepared contract through first telemetry and accepts only an exact user echo', async () => {
    const claude = fakeClaude({ replayUuid: null, initModels: [], settings: {} })
    const settled = vi.fn()
    const adapter = await acquired(claude, { contextDeliveryVersion: '2.1.309' }, [], settled)
    await claudeOpened(adapter, 'session-1')
    const before = adapter.contextDeliveryCapabilities('session-1')
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'trigger',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(adapter.contextDeliveryCapabilities('session-1')).toEqual(before)
    const connection = claude.connections[0]
    connection.handlers.onMessage?.({ ...connection.sent[0] })
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'trigger', originCorrelation: 'exact' })
    )
  })
  it('uses the observed Claude binary version without requiring a first model turn', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude, { contextDeliveryVersion: '2.1.309' })
    await claudeOpened(adapter, 'session-1')
    expect(claude.connections[0].sent).toHaveLength(0)
    expect(adapter.contextDeliveryCapabilities('session-1')).toMatchObject({
      state: 'verified',
      passiveImport: 'unsupported'
    })
    claude.connections[0].closed = true
    expect(adapter.contextDeliveryCapabilities('session-1')).toEqual({ state: 'unverified' })
  })
  it('revokes cached Claude version evidence when the live runtime contradicts it', async () => {
    const claude = fakeClaude()
    const adapter = await acquired(claude, { contextDeliveryVersion: '2.1.309' })
    expect(adapter.contextDeliveryCapabilities('session-1')).toMatchObject({ state: 'verified' })
    claude.connections[0].handlers.onMessage?.({
      type: 'system',
      subtype: 'init',
      session_id: PROVIDER_SESSION_ID,
      claude_code_version: '99.0.0'
    })
    expect(adapter.contextDeliveryCapabilities('session-1')).toEqual({ state: 'unverified' })
  })
  it('requires initialized OpenCode ACP contract and opened native session', async () => {
    const rig = await openAcpAdapterRig({
      spec: acpLaunchSpecFor('opencode')!,
      initialize: { agentInfo: { name: 'OpenCode', version: '1.19.4' } }
    })
    expect(rig.adapter.contextDeliveryCapabilities(SESSION)).toEqual({ state: 'unverified' })
    await rig.acquire()
    expect(rig.adapter.contextDeliveryCapabilities(SESSION)).toMatchObject({
      state: 'verified',
      budget: 'unknown'
    })
  })
})
