import { useEffect, useReducer } from 'react'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '../../store'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import { LificTaskConsole } from './LificTaskConsole'
import { lificCopy } from './lific-integration-copy'
import { LificConnectionProfileForm } from './LificConnectionProfileForm'
import { LificIntegrationActions } from './LificIntegrationActions'
import { LificIntegrationSummary } from './LificIntegrationSummary'
import {
  buildLificConnectionProfile,
  createLificIntegrationState,
  profileToLificIntegrationState,
  reduceLificIntegrationState
} from './lific-integration-state'
import {
  lificAgentsMd,
  lificBindRepo,
  lificConnect,
  lificContext,
  lificDisconnect,
  lificProfiles,
  lificPutProfile,
  lificReconnect,
  lificStatus,
  lificStoreCredential
} from '../../runtime/runtime-lific-client'

type Props = { repo: Repo }

export function LificIntegrationSection({ repo }: Props): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const executionHostId = getRepoExecutionHostId(repo)
  const profileId = `repo:${repo.id}:lific:${executionHostId}`
  const credentialRef = `lific:management:${profileId}`
  const [state, updateState] = useReducer(
    reduceLificIntegrationState,
    Boolean(repo.connectionId),
    createLificIntegrationState
  )
  const {
    mode,
    targetMode,
    wslDistribution,
    sshHost,
    sshPort,
    baseUrl,
    mcpUrl,
    databasePath,
    projectIdentifier,
    agent,
    scope,
    authentication,
    managementCredential,
    profile,
    health,
    preview,
    busy
  } = state

  useEffect(() => {
    let cancelled = false
    void lificProfiles(settings)
      .then((profiles) => {
        if (cancelled) {
          return
        }
        const current = profiles.find((entry) => entry.id === profileId)
        if (!current) {
          return
        }
        updateState(profileToLificIntegrationState(current))
        void lificContext(settings, {
          repoId: repo.id,
          agentProfileId: 'codex',
          executionHostId: current.executionHostId
        })
          .then((context) => {
            if (!cancelled && context.projectIdentifier) {
              updateState({ projectIdentifier: context.projectIdentifier })
            }
          })
          .catch(() => undefined)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [profileId, repo.id, settings])

  const draft = buildLificConnectionProfile({
    state,
    profileId,
    credentialRef,
    executionHostId,
    repoConnectionId: repo.connectionId,
    repoDisplayName: repo.displayName
  })

  const run = async (action: () => Promise<void>): Promise<void> => {
    updateState({ busy: true })
    try {
      await action()
    } catch (error) {
      toast.error(extractIpcErrorMessage(error, lificCopy.operationFailed()))
    } finally {
      updateState({ busy: false })
    }
  }

  const save = async (): Promise<void> => {
    if (targetMode === 'ssh') {
      if (!sshHost.trim()) {
        throw new Error(lificCopy.sshDestinationRequired())
      }
      if (sshPort.trim()) {
        const parsedPort = Number(sshPort)
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          throw new Error(lificCopy.sshPortInvalid())
        }
      }
    }
    if (targetMode === 'wsl' && !wslDistribution.trim()) {
      throw new Error(lificCopy.wslDistributionRequired())
    }
    if (mode === 'http' && (!baseUrl.trim() || !mcpUrl.trim())) {
      throw new Error(lificCopy.serverUrlsRequired())
    }
    if (mode === 'stdio' && !databasePath.trim()) {
      throw new Error(lificCopy.databasePathRequired())
    }
    if (mode === 'http' && managementCredential.trim()) {
      await lificStoreCredential(settings, credentialRef, managementCredential.trim())
      updateState({ managementCredential: '' })
    }
    const saved = await lificPutProfile(settings, draft)
    const normalizedProject = projectIdentifier.trim()
    await lificBindRepo(settings, {
      repoId: repo.id,
      connectionProfileId: profileId,
      ...(normalizedProject ? { projectIdentifier: normalizedProject } : {}),
      agentsMdMode: 'offer'
    })
    updateState({ profile: saved })
  }

  const connect = async (dryRun: boolean): Promise<void> => {
    if (dryRun) {
      if (!profile) {
        throw new Error(lificCopy.saveBeforePreview())
      }
    } else {
      await save()
    }
    const result = await lificConnect(settings, {
      profileId,
      agent,
      agentProfileId: agent,
      scope,
      authentication,
      dryRun,
      cwd: repo.path
    })
    updateState({ preview: result.stdout ?? '' })
    if (!dryRun) {
      toast.success(
        result.accessMode === 'mcp' ? lificCopy.mcpConnected() : lificCopy.cliFallbackEnabled()
      )
    }
  }

  const refreshStatus = async (): Promise<void> => {
    const result = await lificStatus(settings, profileId)
    updateState({ health: result.state })
  }

  const reconnect = async (): Promise<void> => {
    const result = await lificReconnect(settings, {
      profileId,
      agent,
      agentProfileId: agent,
      scope,
      authentication,
      cwd: repo.path
    })
    updateState({ preview: result.stdout ?? '' })
    toast.success(lificCopy.reconnected())
  }

  const disconnect = async (): Promise<void> => {
    await lificDisconnect(settings, profileId, agent)
    toast.success(lificCopy.disconnected())
  }

  const updateAgentsMd = async (): Promise<void> => {
    const normalizedProject = projectIdentifier.trim()
    await lificAgentsMd(settings, {
      profileId,
      path: `${repo.path}/AGENTS.md`,
      ...(normalizedProject ? { projectIdentifier: normalizedProject } : {})
    })
    toast.success(lificCopy.agentsMdUpdated())
  }

  return (
    <section className="space-y-4">
      <LificIntegrationSummary
        executionHostId={draft.executionHostId}
        busy={busy}
        hasProfile={Boolean(profile)}
        health={health}
        preview={preview}
        onRefresh={() => void run(refreshStatus)}
      />

      <LificConnectionProfileForm profileId={profileId} state={state} onChange={updateState} />

      <LificIntegrationActions
        busy={busy}
        hasProfile={Boolean(profile)}
        onSave={() => void run(save)}
        onPreview={() => void run(() => connect(true))}
        onConnect={() => void run(() => connect(false))}
        onReconnect={() => void run(reconnect)}
        onDisconnect={() => void run(disconnect)}
        onUpdateAgentsMd={() => void run(updateAgentsMd)}
      />

      <LificTaskConsole
        settings={settings}
        profileId={profileId}
        preferredProjectIdentifier={projectIdentifier.trim() || undefined}
        disabled={!profile}
      />
    </section>
  )
}
