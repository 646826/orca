import { test, SUPPORTED } from './helpers/conversation-native-stubs'
import { expect } from './helpers/orca-app'
import { startConversationFixture, chatRoot } from './helpers/conversation-switch-journey'

test('Agent picker keyboard dismissal returns DOM focus without a native switch', async ({
  orcaPage: page,
  conversationStubs: stubs
}, info) => {
  test.skip(!SUPPORTED, 'Fixture wrappers are POSIX-only')
  await startConversationFixture(page, stubs, 'claude')
  await page.setViewportSize({ width: 760, height: 640 })
  const picker = chatRoot(page).getByRole('button', { name: /^Agent / })
  await picker.focus()
  await picker.press('ArrowDown')
  await expect(page.getByRole('combobox', { name: 'Search agents…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect
    .poll(() => picker.evaluate((element) => element === element.ownerDocument.activeElement))
    .toBe(true)
  expect(stubs.inputs('codex')).toHaveLength(0)
  expect(stubs.inputs('opencode')).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('agent-picker-narrow.png') })
})
