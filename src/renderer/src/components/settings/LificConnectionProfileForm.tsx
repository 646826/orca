import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { lificCopy } from './lific-integration-copy'
import type {
  ExecutionTargetMode,
  LificIntegrationState,
  Mode
} from './lific-integration-state'

export type { ExecutionTargetMode, Mode } from './lific-integration-state'

type Props = {
  profileId: string
  state: LificIntegrationState
  onChange: (patch: Partial<LificIntegrationState>) => void
}

export function LificConnectionProfileForm({
  profileId,
  state,
  onChange
}: Props): React.JSX.Element {
  const {
    targetMode,
    wslDistribution,
    sshHost,
    sshPort,
    sshIdentityFile,
    mode,
    agent,
    baseUrl,
    mcpUrl,
    managementCredential,
    authentication,
    databasePath,
    projectIdentifier,
    scope
  } = state

  return (
    <div className="grid gap-3 rounded-md border border-border/50 p-3 md:grid-cols-2">
      <label className="space-y-1 text-xs">
        <span className="font-medium">{lificCopy.executionTarget()}</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={targetMode}
          onChange={(event) =>
            onChange({ targetMode: event.target.value as ExecutionTargetMode })
          }
        >
          <option value="current">{lificCopy.currentRuntime()}</option>
          <option value="wsl">{lificCopy.wslDistribution()}</option>
          <option value="ssh">{lificCopy.sshHost()}</option>
        </select>
      </label>
      {targetMode === 'wsl' ? (
        <div className="space-y-1">
          <Label htmlFor={`${profileId}-wsl`}>{lificCopy.wslDistribution()}</Label>
          <Input
            id={`${profileId}-wsl`}
            value={wslDistribution}
            onChange={(event) => onChange({ wslDistribution: event.target.value })}
          />
        </div>
      ) : targetMode === 'ssh' ? (
        <div className="space-y-1">
          <Label htmlFor={`${profileId}-ssh-host`}>{lificCopy.sshDestination()}</Label>
          <Input
            id={`${profileId}-ssh-host`}
            value={sshHost}
            onChange={(event) => onChange({ sshHost: event.target.value })}
            placeholder={lificCopy.sshDestinationPlaceholder()}
          />
        </div>
      ) : (
        <div />
      )}
      {targetMode === 'ssh' ? (
        <>
          <div className="space-y-1">
            <Label htmlFor={`${profileId}-ssh-port`}>{lificCopy.sshPort()}</Label>
            <Input
              id={`${profileId}-ssh-port`}
              value={sshPort}
              onChange={(event) => onChange({ sshPort: event.target.value })}
              placeholder="22"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${profileId}-ssh-key`}>{lificCopy.identityFile()}</Label>
            <Input
              id={`${profileId}-ssh-key`}
              value={sshIdentityFile}
              onChange={(event) => onChange({ sshIdentityFile: event.target.value })}
              placeholder={lificCopy.optionalPath()}
            />
          </div>
        </>
      ) : null}
      <label className="space-y-1 text-xs">
        <span className="font-medium">{lificCopy.connectionMode()}</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={mode}
          onChange={(event) => onChange({ mode: event.target.value as Mode })}
        >
          <option value="http">{lificCopy.httpServer()}</option>
          <option value="stdio">{lificCopy.localStdio()}</option>
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="font-medium">{lificCopy.agentHarness()}</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={agent}
          onChange={(event) => onChange({ agent: event.target.value })}
        >
          {['codex', 'claude', 'opencode', 'gemini', 'goose', 'crush', 'cursor', 'pi'].map(
            (value) => (
              <option key={value} value={value}>
                {value}
              </option>
            )
          )}
        </select>
      </label>
      {mode === 'http' ? (
        <>
          <div className="space-y-1">
            <Label htmlFor={`${profileId}-base-url`}>{lificCopy.serverUrl()}</Label>
            <Input
              id={`${profileId}-base-url`}
              value={baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${profileId}-mcp-url`}>{lificCopy.mcpUrl()}</Label>
            <Input
              id={`${profileId}-mcp-url`}
              value={mcpUrl}
              onChange={(event) => onChange({ mcpUrl: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${profileId}-credential`}>{lificCopy.managementCredential()}</Label>
            <Input
              id={`${profileId}-credential`}
              type="password"
              autoComplete="off"
              value={managementCredential}
              onChange={(event) => onChange({ managementCredential: event.target.value })}
              placeholder={lificCopy.protectedCredentialPlaceholder()}
            />
          </div>
          <label className="space-y-1 text-xs">
            <span className="font-medium">{lificCopy.agentAuthentication()}</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2"
              value={authentication}
              onChange={(event) =>
                onChange({ authentication: event.target.value as 'bot' | 'oauth' })
              }
            >
              <option value="bot">{lificCopy.perHarnessBot()}</option>
              <option value="oauth">{lificCopy.oauthHeaderless()}</option>
            </select>
          </label>
        </>
      ) : (
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor={`${profileId}-db`}>{lificCopy.databasePath()}</Label>
          <Input
            id={`${profileId}-db`}
            value={databasePath}
            onChange={(event) => onChange({ databasePath: event.target.value })}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${profileId}-project`}>{lificCopy.projectIdentifier()}</Label>
        <Input
          id={`${profileId}-project`}
          value={projectIdentifier}
          onChange={(event) => onChange({ projectIdentifier: event.target.value })}
          placeholder={lificCopy.projectIdentifierPlaceholder()}
        />
      </div>
      <label className="space-y-1 text-xs">
        <span className="font-medium">{lificCopy.clientConfigScope()}</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={scope}
          onChange={(event) => onChange({ scope: event.target.value as 'global' | 'project' })}
        >
          <option value="global">{lificCopy.globalRecommended()}</option>
          <option value="project">{lificCopy.project()}</option>
        </select>
      </label>
    </div>
  )
}
