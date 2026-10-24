import {
  remoteConversationSaveAuthority,
  assertRemoteConversationLayoutClose
} from './runtime-environments/remote-conversation-save-authority'
import { parseExecutionHostId } from '../../shared/execution-host'
import { assertConversationLayoutCommand } from '../runtime/rpc/methods/conversation-layout-gate'
import { assertConversationLayoutSave } from '../persistence/conversation-layout-save'
import { resolveHostId } from '../persistence/loading-store/session-host-partitions'
import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseTerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import { windowViewPatchForMain, windowViewSaveForMain } from '../persistence/window-save-view'
import { reportWindowSaveDrift } from '../persistence/window-save-divergence'
import { windowSaveKeepingMainSleepRecords } from '../persistence/window-save-sleep-records'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'

export function registerSessionHandlers(store: Store, runtime: OrcaRuntimeService): void {
  // Why: renderer saves would change a fenced host's frozen source partition.
  const isFenced = (hostId?: string | null): boolean =>
    isFrozenOrcadSourceSessionPartition(store, hostId)

  const surfacesFor = (
    records: Awaited<ReturnType<OrcaRuntimeService['openAgentSessionRecordStore']>>,
    hostId: ReturnType<typeof resolveHostId>,
    incoming: WorkspaceSessionState
  ) => {
    if (parseExecutionHostId(hostId)?.kind === 'runtime') {
      return remoteConversationSaveAuthority({
        userDataPath: app.getPath('userData'),
        hostId,
        current: store.getWorkspaceSession(hostId),
        incoming
      })
    }
    return records.conversations.surfaces.list({ executionHostId: hostId, includeHidden: true })
  }

  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  // Why a census channel: boot used to infer which partitions exist from the repo catalog, which
  // cannot name an SSH target whose only workspace is a folder — the runtime wrote that partition
  // and no reader ever enumerated it (#12723).
  ipcMain.handle('session:list-host-ids', () => {
    return store.getWorkspaceSessionHostIds()
  })

  // Switch point: main keeps its own layout over the window's and takes the window's view and
  // facts; the drift check reports where the save's layout still differs from main's.
  const sessionForMain = (args: WorkspaceSessionState, hostId: string | null | undefined) => {
    const stored = store.getWorkspaceSession(hostId)
    reportWindowSaveDrift(stored, args, hostId, 'session:set')
    return windowViewSaveForMain(stored, args, hostId, (session, partition) =>
      runtime.shutdownReconnectFactsFor(session, partition)
    )
  }
  const patchForMain = (args: WorkspaceSessionPatch, hostId: string | null | undefined) => {
    const stored = store.getWorkspaceSession(hostId)
    reportWindowSaveDrift(stored, { ...stored, ...args }, hostId, 'session:patch')
    return windowViewPatchForMain(stored, args, hostId, (session, partition) =>
      runtime.shutdownReconnectFactsFor(session, partition)
    )
  }

  ipcMain.handle(
    'session:set',
    async (_event, args: WorkspaceSessionState, hostId?: string | null) => {
      if (isFenced(hostId)) {
        return
      }
      const records = await runtime.openAgentSessionRecordStore()
      if (isFenced(hostId)) {
        return
      }
      const resolved = resolveHostId(hostId)
      assertConversationLayoutSave(args, surfacesFor(records, resolved, args), resolved)
      store.setWorkspaceSession(
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? sessionForMain(args, hostId)
          : windowSaveKeepingMainSleepRecords(store.getWorkspaceSession(hostId), args, 'set'),
        hostId
      )
    }
  )

  ipcMain.handle(
    'session:patch',
    async (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
      if (isFenced(hostId)) {
        return
      }
      // All saves share readiness ordering; a view patch must not overtake an earlier full save.
      const records = await runtime.openAgentSessionRecordStore()
      if (isFenced(hostId)) {
        return
      }
      if (
        Object.hasOwn(args, 'unifiedTabs') ||
        Object.hasOwn(args, 'tabGroups') ||
        Object.hasOwn(args, 'tabGroupLayouts')
      ) {
        const resolved = resolveHostId(hostId)
        assertConversationLayoutSave(
          { ...store.getWorkspaceSession(hostId), ...args },
          surfacesFor(records, resolved, { ...store.getWorkspaceSession(hostId), ...args }),
          resolved
        )
      }
      store.patchWorkspaceSession(
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? patchForMain(args, hostId)
          : windowSaveKeepingMainSleepRecords(store.getWorkspaceSession(hostId), args, 'patch'),
        hostId
      )
    }
  )

  // Why: a renderer save cannot shrink membership main owns, so each close commits it explicitly.
  ipcMain.handle(
    'session:close-terminal-surface',
    (_event, args: { worktreeId?: unknown; target?: unknown; reason?: unknown } | undefined) => {
      const target = parseTerminalSurfaceCloseTarget(args?.target)
      if (typeof args?.worktreeId !== 'string' || !target) {
        throw new Error('invalid_terminal_surface')
      }
      // Why only these two: main alone closes a tab for its process exit.
      const reason = args.reason === 'cleanup' ? 'cleanup' : 'user'
      const worktreeId = args.worktreeId
      return runtime.openAgentSessionRecordStore().then((records) => {
        const check = () => {
          assertRemoteConversationLayoutClose({
            userDataPath: app.getPath('userData'),
            hostIds: store.getWorkspaceSessionHostIds(),
            readSession: (hostId) => store.getWorkspaceSession(hostId),
            workspaceId: worktreeId,
            tabId: target.tabId
          })
          assertConversationLayoutCommand(
            records,
            {
              type: 'closeTabs',
              workspace: worktreeId,
              tabIds: [target.tabId]
            },
            false
          )
        }
        check()
        return runtime.closeTerminalSurfaceFromRenderer({ worktreeId, target, reason }, () => {
          check()
          if (reason === 'user') {
            markAgentLaunchesClosedByUser(worktreeId, target)
          }
        })
      })
    }
  )

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    return store.flushPendingOrThrowAsync()
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}
