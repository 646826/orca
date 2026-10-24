import { expect, test, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
class InventoryRuntime extends OrcaRuntimeService {
  read(workspaceId: string) {
    return this.mobileSessionTabsByWorktree.get(workspaceId)
  }
}
test('publishes a conversation-only workspace with increasing existing snapshot and change sequence', () => {
  const runtime = new InventoryRuntime(null)
  const changed = vi.fn()
  const stop = runtime.onMobileSessionTabsChanged(changed)
  try {
    expect(runtime.read('folder:conversation')).toBeUndefined()
    runtime.publishConversationInventory('folder:conversation')
    const first = runtime.read('folder:conversation')!
    expect(first.tabs).toEqual([])
    expect(first.snapshotVersion).toBe(1)
    runtime.publishConversationInventory('folder:conversation')
    const second = runtime.read('folder:conversation')!
    expect(second.publicationEpoch).toBe(first.publicationEpoch)
    expect(second.snapshotVersion).toBe(2)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1][1]).toBeGreaterThan(changed.mock.calls[0][1])
  } finally {
    stop()
  }
})
