import { expect, it } from 'vitest'
import { createRemoteConversationSurfaceInventory } from './remote-conversation-surface-inventory'

const surface = {
  conversationId: 'conversation',
  sourceSessionId: 'source',
  tabId: 'tab',
  visible: true,
  surfaceRevision: 1,
  publishedRevision: 1,
  location: {
    executionHostId: 'local' as const,
    workspaceId: 'workspace',
    workspaceKind: 'folder' as const,
    wslDistro: null
  }
}
const snapshot = (version = 1) => ({
  worktree: 'workspace',
  publicationEpoch: 'epoch',
  snapshotVersion: version,
  conversationSurfaces: { complete: true, surfaces: [surface] }
})

it('uses only a complete authenticated census and maps its exact environment partition', () => {
  const inventory = createRemoteConversationSurfaceInventory()
  const stream = inventory.open('remote', 1)
  expect(inventory.read('remote', 1)).toBeNull()
  inventory.record(
    stream,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [snapshot()] },
    1
  )
  expect(inventory.read('remote', 1)).toEqual([
    { ...surface, location: { ...surface.location, executionHostId: 'runtime:remote' } }
  ])
  expect(inventory.read('other', 1)).toBeNull()
  expect(inventory.read('remote', 2)).toBeNull()
})

it('rejects replaced streams, disconnects, incomplete old-host frames and scope corruption', () => {
  const inventory = createRemoteConversationSurfaceInventory()
  const old = inventory.open('remote', 1)
  inventory.record(
    old,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [snapshot()] },
    1
  )
  const next = inventory.open('remote', 1)
  inventory.record(
    old,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [snapshot()] },
    1
  )
  expect(inventory.read('remote', 1)).toBeNull()
  inventory.record(
    next,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [snapshot()] },
    1
  )
  inventory.close(old)
  expect(inventory.read('remote', 1)).not.toBeNull()
  inventory.record(next, { type: 'updated', ...snapshot(2), conversationSurfaces: undefined }, 1)
  expect(inventory.read('remote', 1)).toBeNull()
  inventory.record(
    next,
    {
      type: 'snapshots',
      conversationSurfacesComplete: true,
      snapshots: [{ ...snapshot(), worktree: 'foreign' }]
    },
    1
  )
  expect(inventory.read('remote', 1)).toBeNull()
  inventory.record(
    next,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [snapshot()] },
    1
  )
  inventory.close(next)
  expect(inventory.read('remote', 1)).toBeNull()
})

it('preserves hidden bindings and rejects stale updates and duplicate identities', () => {
  const inventory = createRemoteConversationSurfaceInventory()
  const stream = inventory.open('remote', 1)
  inventory.record(
    stream,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [snapshot(2)] },
    1
  )
  inventory.record(
    stream,
    { type: 'updated', ...snapshot(1), conversationSurfaces: { complete: true, surfaces: [] } },
    1
  )
  expect(inventory.read('remote', 1)).toHaveLength(1)
  inventory.record(
    stream,
    {
      type: 'updated',
      ...snapshot(3),
      conversationSurfaces: {
        complete: true,
        surfaces: [{ ...surface, visible: false, surfaceRevision: 2 }]
      }
    },
    1
  )
  expect(inventory.read('remote', 1)?.[0]?.visible).toBe(false)
  inventory.record(
    stream,
    {
      type: 'updated',
      ...snapshot(4),
      conversationSurfaces: { complete: true, surfaces: [surface, surface] }
    },
    1
  )
  expect(inventory.read('remote', 1)).toBeNull()
})

it('does not interpret an old host empty census as verified absence', () => {
  const inventory = createRemoteConversationSurfaceInventory()
  const stream = inventory.open('remote', 1)
  inventory.record(stream, { type: 'snapshots', snapshots: [] }, 1)
  expect(inventory.read('remote', 1)).toBeNull()
  inventory.record(
    stream,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [] },
    1
  )
  expect(inventory.read('remote', 1)).toEqual([])
})

it('invalidates authority on a terminal frame and refuses a second census on the same stream', () => {
  const inventory = createRemoteConversationSurfaceInventory()
  const stream = inventory.open('remote', 1)
  const initial = {
    type: 'snapshots',
    conversationSurfacesComplete: true,
    snapshots: [snapshot(2)]
  }
  inventory.record(stream, initial, 1)
  inventory.record(stream, { type: 'end' }, 1)
  expect(inventory.read('remote', 1)).toBeNull()
  const next = inventory.open('remote', 2)
  inventory.record(next, initial, 2)
  inventory.record(
    next,
    { type: 'snapshots', conversationSurfacesComplete: true, snapshots: [] },
    2
  )
  expect(inventory.read('remote', 2)).toBeNull()
})
