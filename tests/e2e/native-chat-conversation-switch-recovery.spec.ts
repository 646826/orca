import { test, SUPPORTED } from './helpers/conversation-native-stubs'
import { expect } from './helpers/orca-app'
import { z } from 'zod'
import {
  startConversationFixture,
  sendConversationText,
  selectConversationAgent,
  readConversationSurface,
  prepareConversationSwitch
} from './helpers/conversation-switch-journey'

test('unknown native acceptance keeps the old active owner and never blindly replays the trigger', async ({
  orcaPage: page,
  conversationStubs: stubs
}, info) => {
  test.skip(!SUPPORTED, 'Fixture wrappers are POSIX-only')
  test.setTimeout(180_000)
  const scope = await startConversationFixture(page, stubs, 'claude')
  await sendConversationText(page, 'Preserve the original task constraint.')
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0)
  await selectConversationAgent(page, 'codex')
  stubs.holdAcceptance('codex')
  await prepareConversationSwitch(page)
  await sendConversationText(page, 'FIRST_TRIGGER_UNKNOWN')
  await page.getByRole('button', { name: 'Continue switch', exact: true }).click()
  await expect.poll(() => stubs.inputs('codex').length).toBe(1)
  await sendConversationText(page, 'SECOND_QUEUED_INTENT')
  await expect
    .poll(
      async () =>
        (await readConversationSurface(page, scope.workspaceId, scope.tabId)).operation?.phase,
      { timeout: 90_000 }
    )
    .toBe('reconciliation-required')
  const uncertain = await readConversationSurface(page, scope.workspaceId, scope.tabId)
  expect(uncertain.active.sessionId).toBe(scope.sessionId)
  await page.getByRole('button', { name: 'Reconcile this switch', exact: true }).click()
  expect(stubs.inputs('codex')).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('unknown-acceptance.png') })
  stubs.releaseAcceptance('codex')
  await page.getByRole('button', { name: 'Reconcile this switch', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await readConversationSurface(page, scope.workspaceId, scope.tabId)).active.agent,
      { timeout: 30_000 }
    )
    .toBe('codex')
  await expect.poll(() => stubs.inputs('codex').length).toBe(2)
  const inputs = stubs.inputs('codex').map((row) => JSON.stringify(row.input))
  expect(inputs.filter((input) => input.includes('FIRST_TRIGGER_UNKNOWN'))).toHaveLength(1)
  expect(inputs.filter((input) => input.includes('SECOND_QUEUED_INTENT'))).toHaveLength(1)
  const activated = await readConversationSurface(page, scope.workspaceId, scope.tabId)
  expect(activated.operation).toBeNull()
  const operationKey = uncertain.operation?.operationKey
  if (!operationKey) {
    throw new Error('Unknown acceptance lost its durable operation identity')
  }
  const persistedReply = await page.evaluate(
    (operationKey) =>
      window.api.runtime.call({ method: 'conversation.preparation', params: { operationKey } }),
    operationKey
  )
  const persisted = z
    .object({
      ok: z.literal(true),
      result: z.object({
        operationKey: z.string(),
        conversationId: z.string(),
        phase: z.literal('activated'),
        contextGeneration: z.number(),
        activeSessionId: z.string(),
        selectedSessionId: z.string()
      })
    })
    .parse(persistedReply).result
  expect(persisted.operationKey).toBe(operationKey)
  expect(persisted.conversationId).toBe(uncertain.conversation.conversationId)
  expect(persisted.contextGeneration).toBe(uncertain.conversation.contextGeneration)
  expect(persisted.selectedSessionId).toBe(uncertain.selected?.sessionId)
  expect(persisted.activeSessionId).toBe(activated.active.sessionId)
})

test('busy source remains controllable while switching quiesces', async ({
  orcaPage: page,
  conversationStubs: stubs
}) => {
  test.skip(!SUPPORTED, 'Fixture wrappers are POSIX-only')
  test.setTimeout(120_000)
  const scope = await startConversationFixture(page, stubs, 'claude')
  await sendConversationText(page, 'FIXTURE_HOLD_TURN')
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible()
  await selectConversationAgent(page, 'opencode')
  const before = await readConversationSurface(page, scope.workspaceId, scope.tabId)
  expect(before.operation?.phase).toBe('quiescing')
  expect(before.active.sessionId).toBe(scope.sessionId)
  await page.getByRole('button', { name: 'Stop the agent' }).click()
  await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0)
  expect(stubs.inputs('opencode')).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Continue switch', exact: true })).toBeEnabled()
})
