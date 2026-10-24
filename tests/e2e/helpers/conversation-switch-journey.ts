import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect } from './orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './store'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import type { ConversationNativeStubs, ConversationFixtureAgent } from './conversation-native-stubs'
import { createStructuredAgentSessionId } from '../../../src/shared/structured-agent-session-create'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import { ConversationSurfaceSnapshotSchema } from '../../../src/shared/conversation-surface-rpc'

export const agentNames = { claude: /Claude/, codex: /Codex/, opencode: /OpenCode/i }
export const chatRoot = (page: Page) => page.locator('[data-native-chat-root="true"]')
export async function startConversationFixture(
  page: Page,
  stubs: ConversationNativeStubs,
  agent: ConversationFixtureAgent
) {
  await waitForSessionReady(page)
  const statusReply = await page.evaluate(() =>
    window.api.runtime.call({ method: 'status.get', params: {} })
  )
  const status = z
    .object({ ok: z.literal(true), result: z.object({ capabilities: z.array(z.string()) }) })
    .parse(statusReply)
  expect(
    status.result.capabilities,
    'Host must advertise supported aggregate reads/mutations'
  ).toContain('agent-session.conversations.v2')
  const workspaceId = await waitForActiveWorktree(page)
  await page.evaluate(
    async ({ commands, agent }) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        defaultTuiAgent: agent,
        agentCmdOverrides: commands
      })
    },
    {
      agent,
      commands: {
        claude: buildFakeAgentCommandOverride(stubs.commands.claude),
        codex: buildFakeAgentCommandOverride(stubs.commands.codex),
        opencode: buildFakeAgentCommandOverride(stubs.commands.opencode)
      }
    }
  )
  const sessionId = createStructuredAgentSessionId(agent, randomUUID)
  const worktree = `id:${workspaceId}`
  const reply = await page.evaluate(
    (params) => window.api.runtime.call({ method: 'agentSession.create', params }),
    {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionCreateFingerprint({ sessionId, worktree, agent })
      },
      worktree,
      agent
    }
  )
  expect(reply).toMatchObject({ ok: true })
  const tab = async () =>
    page.evaluate(
      ({ workspaceId, sessionId }) =>
        window.__store
          ?.getState()
          .unifiedTabsByWorktree[workspaceId]?.find((tab) => tab.entityId === sessionId)?.id,
      { workspaceId, sessionId }
    )
  await expect.poll(tab).toBeTruthy()
  const tabId = await tab()
  if (!tabId) {
    throw new Error('Created native tab missing')
  }
  await page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).click()
  await expect(chatRoot(page).getByRole('textbox')).toBeVisible()
  return { workspaceId, tabId, sessionId }
}
export async function sendConversationText(page: Page, text: string) {
  const composer = chatRoot(page).getByRole('textbox')
  await composer.fill(text)
  await chatRoot(page).getByRole('button', { name: 'Send', exact: true }).click()
}
export async function selectConversationAgent(page: Page, agent: ConversationFixtureAgent) {
  await chatRoot(page)
    .getByRole('button', { name: /^Agent / })
    .click()
  await page.getByRole('option', { name: agentNames[agent] }).click()
  await expect(page.getByText(/Selected agent:/)).toBeVisible()
}
export async function readConversationSurface(page: Page, workspaceId: string, tabId: string) {
  const conversationId = await page.evaluate(
    ({ workspaceId, tabId }) => {
      const tab = window.__store
        ?.getState()
        .unifiedTabsByWorktree[workspaceId]?.find((tab) => tab.id === tabId)
      return tab?.contentType === 'conversation' ? tab.entityId : null
    },
    { workspaceId, tabId }
  )
  if (!conversationId) {
    throw new Error('Same tab was not promoted to a conversation')
  }
  const raw = await page.evaluate(
    (conversationId) =>
      window.api.runtime.call({ method: 'conversation.surfaceRead', params: { conversationId } }),
    conversationId
  )
  return ConversationSurfaceSnapshotSchema.parse(
    z.object({ ok: z.literal(true), result: z.unknown() }).parse(raw).result
  )
}
/** Each click is a visible, explicit choice; no fake consent/receipt or direct activation RPC. */
export async function prepareConversationSwitch(page: Page) {
  for (let step = 0; step < 10; step++) {
    const approve = page.getByRole('button', { name: 'Approve this projection', exact: true })
    if (await approve.isVisible()) {
      await approve.click()
      return
    }
    const trust = page.getByRole('button', { name: 'Approve this native startup', exact: true })
    const budget = page.getByRole('button', { name: 'Review budgeted delivery', exact: true })
    const advance = page.getByRole('button', { name: 'Continue switch', exact: true })
    if (await trust.isVisible()) {
      await trust.click()
    } else if (await budget.isVisible()) {
      await budget.click()
    } else {
      await expect(advance).toBeEnabled()
      await advance.click()
    }
    await expect
      .poll(async () => !(await advance.isVisible()) || (await advance.isEnabled()), {
        timeout: 30_000
      })
      .toBe(true)
  }
  throw new Error('Visible preparation did not produce an approvable projection')
}
