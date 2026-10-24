import {
  ConversationSurfaceInventorySchema,
  RuntimeMobileSessionConversationTabSchema,
  MAX_CONVERSATION_INVENTORY_BYTES
} from '../../../src/shared/conversation-inventory'
import type { MobileSessionTab, SessionTabsResult } from './mobile-session-route-types'

/** An incomplete census is no evidence that a previously visible aggregate disappeared. */
export function reconcileMobileConversationInventory(
  result: SessionTabsResult,
  previous: readonly MobileSessionTab[]
): SessionTabsResult {
  const ordinary = result.tabs.filter((tab) => tab.type !== 'conversation')
  const prior = previous.filter((tab) => tab.type === 'conversation')
  const keepPrevious = (): SessionTabsResult => ({
    ...result,
    tabs: [...ordinary.filter((tab) => !prior.some((old) => old.id === tab.id)), ...prior]
  })
  const raw = result.conversationSurfaces
  if (
    !raw ||
    new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_CONVERSATION_INVENTORY_BYTES
  ) {
    return keepPrevious()
  }
  const census = ConversationSurfaceInventorySchema.safeParse(raw)
  if (!census.success || !census.data.complete) {
    return keepPrevious()
  }
  const parsed = result.tabs
    .filter((tab) => tab.type === 'conversation')
    .map((tab) => RuntimeMobileSessionConversationTabSchema.safeParse(tab))
  if (parsed.some((row) => !row.success)) {
    return keepPrevious()
  }
  const rows = parsed.flatMap((row) => (row.success ? [row.data] : []))
  const surfaces = census.data.surfaces
  const visible = surfaces.filter((surface) => surface.visible)
  if (
    new Set(surfaces.map((surface) => surface.conversationId)).size !== surfaces.length ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.length !== visible.length ||
    surfaces.some(
      (surface) =>
        surface.location.workspaceId !== result.worktree ||
        surface.publishedRevision !== surface.surfaceRevision ||
        ordinary.some((tab) => tab.id === surface.tabId)
    ) ||
    rows.some(
      (row) =>
        !visible.some(
          (surface) =>
            surface.tabId === row.id &&
            surface.conversationId === row.conversationId &&
            surface.surfaceRevision === row.surfaceRevision
        )
    )
  ) {
    return keepPrevious()
  }
  const checkedRows = new Map(rows.map((row) => [row.id, row]))
  return {
    ...result,
    tabs: result.tabs.flatMap<MobileSessionTab>((tab) => {
      if (tab.type !== 'conversation') {
        return [tab]
      }
      const checked = checkedRows.get(tab.id)
      return checked ? [checked] : []
    })
  }
}
