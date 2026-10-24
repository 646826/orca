import { test, SUPPORTED } from './helpers/conversation-native-stubs'
import { expect } from './helpers/orca-app'
import {
  startConversationFixture,
  sendConversationText,
  selectConversationAgent,
  readConversationSurface,
  prepareConversationSwitch
} from './helpers/conversation-switch-journey'

// Real Electron UI -> RPC -> SQLite/host -> native adapters, with accountless protocol peers.
// This is deliberately not a real-provider login, quality or enforcement test.
const transitions = [
  ['claude', 'codex'],
  ['claude', 'opencode'],
  ['codex', 'claude'],
  ['codex', 'opencode'],
  ['opencode', 'claude'],
  ['opencode', 'codex']
] as const
for (const [from, to] of transitions) {
  test(`${from} to ${to}: same visible conversation, exact first trigger before activation`, async ({
    orcaPage: page,
    conversationStubs: stubs
  }, info) => {
    test.skip(!SUPPORTED, 'Fixture wrappers are POSIX-only')
    test.setTimeout(180_000)
    const scope = await startConversationFixture(page, stubs, from)
    const constraint = 'Keep this exact constraint across the switch: 終端 stays unchanged.'
    await sendConversationText(page, constraint)
    await expect.poll(() => stubs.inputs(from).length).toBe(1)
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`${from}-to-${to}-before.png`) })
    await selectConversationAgent(page, to)
    const selected = await readConversationSurface(page, scope.workspaceId, scope.tabId)
    expect(selected.active.sessionId).toBe(scope.sessionId)
    expect(selected.active.agent).toBe(from)
    expect(selected.selected?.agent).toBe(to)
    stubs.holdAcceptance(to)
    await prepareConversationSwitch(page)
    const trigger = `Continue the task using ${to}; do not repeat earlier tools.`
    await sendConversationText(page, trigger)
    await page.getByRole('button', { name: 'Continue switch', exact: true }).click()
    await expect.poll(() => stubs.inputs(to).length, { timeout: 30_000 }).toBe(1)
    const pending = await readConversationSurface(page, scope.workspaceId, scope.tabId)
    expect(pending.active.sessionId).toBe(scope.sessionId)
    expect(JSON.stringify(stubs.inputs(to)[0]?.input)).toContain(trigger)
    expect(JSON.stringify(stubs.inputs(to)[0]?.input)).toContain('終端')
    await page.screenshot({ path: info.outputPath(`${from}-to-${to}-pending.png`) })
    stubs.releaseAcceptance(to)
    await expect
      .poll(
        async () =>
          (await readConversationSurface(page, scope.workspaceId, scope.tabId)).active.agent,
        { timeout: 30_000 }
      )
      .toBe(to)
    const activated = await readConversationSurface(page, scope.workspaceId, scope.tabId)
    expect(activated.conversation.conversationId).toBe(selected.conversation.conversationId)
    expect(activated.surface?.tabId).toBe(scope.tabId)
    expect(activated.conversation.activeSegmentId).not.toBe(selected.conversation.activeSegmentId)
    expect(stubs.inputs(to)).toHaveLength(1)
    await expect(
      page.locator(`[data-testid="sortable-tab"][data-tab-id="${scope.tabId}"]`)
    ).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${from}-to-${to}-active.png`) })
  })
}

test('Claude → Codex → OpenCode → Claude retains native identity and one aggregate tab', async ({
  orcaPage: page,
  conversationStubs: stubs
}) => {
  test.skip(!SUPPORTED, 'Fixture wrappers are POSIX-only')
  test.setTimeout(300_000)
  const scope = await startConversationFixture(page, stubs, 'claude')
  await sendConversationText(page, 'Original constraint: keep the suffix 終端.')
  await expect.poll(() => stubs.inputs('claude').length).toBe(1)
  const originalNative = stubs.inputs('claude')[0]?.nativeId
  const segments = new Set<string>()
  let aggregate: string | undefined
  for (const target of ['codex', 'opencode', 'claude'] as const) {
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0)
    await selectConversationAgent(page, target)
    const before = await readConversationSurface(page, scope.workspaceId, scope.tabId)
    aggregate ??= before.conversation.conversationId
    expect(before.conversation.conversationId).toBe(aggregate)
    segments.add(before.conversation.activeSegmentId)
    await prepareConversationSwitch(page)
    await sendConversationText(page, `ROUND_TRIP_TRIGGER_${target}`)
    await page.getByRole('button', { name: 'Continue switch', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readConversationSurface(page, scope.workspaceId, scope.tabId)).active.agent,
        { timeout: 30_000 }
      )
      .toBe(target)
    const after = await readConversationSurface(page, scope.workspaceId, scope.tabId)
    expect(segments.has(after.conversation.activeSegmentId)).toBe(false)
    expect(after.surface?.tabId).toBe(scope.tabId)
  }
  expect(stubs.inputs('claude')).toHaveLength(2)
  expect(stubs.inputs('claude')[1]?.nativeId).toBe(originalNative)
  expect(stubs.inputs('codex')).toHaveLength(1)
  expect(stubs.inputs('opencode')).toHaveLength(1)
})
