import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, testContext, WS } from './workspace-layout-command.test-fixture'

const ownership = vi.hoisted(() => ({ main: false }))
vi.mock('../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return ownership.main
  }
}))

function fixture() {
  const context = testContext()
  const { model } = build(context, [
    {
      type: 'openAgentSessionTab',
      workspace: WS,
      tabId: 'visible-chat',
      sessionId: 'source',
      agent: 'codex',
      groupId: 'group',
      createdAt: 7
    }
  ])
  return { context, model }
}
const promote = {
  type: 'promoteConversationTab' as const,
  workspace: WS,
  tabId: 'visible-chat',
  sourceSessionId: 'source',
  conversationId: 'conversation'
}

describe.each([false, true])('conversation layout identity, main owner %s', (main) => {
  beforeEach(() => {
    ownership.main = main
  })
  it('promotes the same visible tab without changing placement or view state', () => {
    const { model, context } = fixture()
    const result = applyLayoutCommand(model, promote, context)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.model.workspaces[WS]!.tabs[0]).toMatchObject({
      id: 'visible-chat',
      entityId: 'conversation',
      kind: 'conversation',
      createdAt: 7
    })
    expect(result.model.workspaces[WS]!.tabs[0]).not.toHaveProperty('agentSessionAgent')
    expect(result.model.workspaces[WS]!.groups).toEqual(model.workspaces[WS]!.groups)
    expect(result.model.records).toEqual(model.records)
    expect(applyLayoutCommand(result.model, promote, context)).toMatchObject({
      ok: true,
      model: result.model
    })
    expect(
      applyLayoutCommand(model, { ...promote, sourceSessionId: 'other' }, context)
    ).toMatchObject({ ok: false })
  })

  it('reopens one conversation identity and refuses a colliding visible id', () => {
    const { context, model } = fixture()
    const command = {
      type: 'openConversationTab' as const,
      workspace: WS,
      conversationId: 'conversation',
      tabId: 'aggregate'
    }
    const first = applyLayoutCommand(model, command, context)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(applyLayoutCommand(first.model, command, context)).toMatchObject({
      ok: true,
      model: first.model
    })
    expect(
      applyLayoutCommand(first.model, { ...command, conversationId: 'other' }, context)
    ).toMatchObject({ ok: false })
    expect(
      applyLayoutCommand(first.model, { ...command, tabId: 'different' }, context)
    ).toMatchObject({ ok: false })
  })
})
