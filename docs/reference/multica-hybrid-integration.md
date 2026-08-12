# Multica Hybrid Integration Design

## Summary

Orca will treat Multica as both a first-class work-management system and an optional execution control plane. A single Multica profile may point to an existing Multica Cloud or self-hosted instance, or to a Docker Compose deployment that Orca can start, stop, restart, inspect, and update on a local, WSL, SSH, or Orca runtime host.

The integration deliberately supports two execution owners:

- **Multica-native execution:** Multica owns agent assignment, queueing, daemon selection, task lifecycle, retries, logs, and completion.
- **Orca-managed execution:** Orca owns the workspace/worktree, terminal, agent process, session, and artifacts, while synchronizing state and comments back to the Multica issue.

Every issue run has exactly one execution owner. The bridge never launches the same work through both systems implicitly.

## Goals

1. Connect to current Multica Cloud and self-hosted instances without requiring a fork-only server patch.
2. Provision and operate an Orca-managed Multica instance where Docker Compose is available.
3. Expose Multica workspaces, projects, issues, labels, properties, comments, runs, agents, skills, squads, runtimes, and usage through typed Orca RPC and CLI surfaces.
4. Use Multica as a native Orca task provider and workspace source.
5. Assign work either to Multica agents or to Orca-managed agents.
6. Preserve the ability to use existing Multica agents, runtimes, skills, and task history.
7. Provide capability negotiation, version reporting, and safe fallbacks across independently upgraded Orca and Multica installations.
8. Work on local, WSL, SSH, and Orca runtime hosts with shell-free process execution.
9. Keep secrets out of argv, ordinary state files, logs, issue comments, and workspace metadata.
10. Keep each implementation slice independently testable and mergeable into `main`.

## Non-goals for the first release

- Replacing Multica's daemon, PostgreSQL database, retry engine, or scheduler.
- Making Orca and Multica co-own one process or worktree.
- Automatically migrating all existing Orca task-provider settings.
- Depending on undocumented database tables or direct PostgreSQL access.
- Requiring Multica to embed Orca as a new built-in agent protocol before the REST/CLI bridge is stable.

## Architecture

The integration is split into five bounded subsystems.

### 1. Connection and lifecycle plane

A host-scoped profile describes how Orca reaches Multica and whether Orca owns the instance lifecycle.

```ts
export type MulticaConnectionProfile = {
  id: string
  displayName: string
  executionHostId: string
  executionTarget?: MulticaExecutionTarget
  dataPlane: MulticaDataPlane
  lifecycle: MulticaInstanceLifecycle
  managedByOrca: boolean
  defaultWorkspaceId?: string
  lastValidatedAt?: number
  lastValidationState?: MulticaHealthState
}
```

`executionHostId` prevents a profile configured on one runtime host from being silently reused on another. `executionTarget` follows the existing Lific host model: local, WSL, SSH, or Orca runtime.

The data plane has two implementations behind one interface:

```ts
export type MulticaDataPlane =
  | {
      kind: 'rest'
      serverUrl: string
      appUrl?: string
      credentialRef: string
      cliFallback?: MulticaCliFallback
    }
  | {
      kind: 'cli'
      executable: string
      profileName?: string
      serverUrl?: string
      credentialRef?: string
    }
```

REST is preferred for existing instances because it avoids terminal-oriented parsing and supports precise HTTP errors. The CLI fallback is used for host-local operations, compatibility with older servers, and commands not yet represented by the typed REST client.

Lifecycle is explicit:

```ts
export type MulticaInstanceLifecycle =
  | { kind: 'external' }
  | {
      kind: 'docker-compose'
      workingDirectory: string
      composeFiles: string[]
      environmentFile?: string
      projectName?: string
      pullBeforeStart: boolean
    }
```

An `external` profile may be inspected but never started, stopped, or updated by Orca. A `docker-compose` profile exposes lifecycle actions using validated argument arrays and `shell: false`.

### 2. Work-management plane

A typed `MulticaTrackerClient` exposes stable Orca-domain operations instead of leaking raw REST or CLI response shapes throughout the application.

```ts
export interface MulticaTrackerClient {
  listWorkspaces(): Promise<MulticaWorkspace[]>
  listProjects(input?: MulticaProjectFilter): Promise<MulticaProject[]>
  getProject(id: string): Promise<MulticaProject>
  listIssues(input: MulticaIssueFilter): Promise<MulticaIssuePage>
  searchIssues(input: MulticaIssueSearch): Promise<MulticaIssuePage>
  getIssue(idOrKey: string): Promise<MulticaIssue>
  createIssue(input: MulticaIssueCreate): Promise<MulticaIssue>
  updateIssue(idOrKey: string, input: MulticaIssueUpdate): Promise<MulticaIssue>
  assignIssue(idOrKey: string, assignee: MulticaAssignee | null): Promise<MulticaIssue>
  listComments(idOrKey: string): Promise<MulticaComment[]>
  addComment(idOrKey: string, body: string): Promise<MulticaComment>
  listRuns(idOrKey: string): Promise<MulticaRun[]>
  listRunMessages(issueIdOrKey: string, taskId: string): Promise<MulticaRunMessage[]>
  cancelRun(issueIdOrKey: string, taskId: string): Promise<void>
  listAgents(): Promise<MulticaAgent[]>
  listSkills(): Promise<MulticaSkill[]>
  listRuntimes(): Promise<MulticaRuntime[]>
}
```

Raw responses are normalized at the transport boundary. Unknown fields remain available in a bounded `raw` object for forward compatibility, but UI and orchestration code consume stable typed fields.

### 3. Execution routing plane

Each Multica-linked Orca workspace records an execution policy:

```ts
export type MulticaExecutionPolicy =
  | { owner: 'multica'; assigneeId: string; assigneeType: 'agent' | 'squad' }
  | { owner: 'orca'; agentProfileId: string; sync: MulticaSyncPolicy }
  | { owner: 'manual' }
```

Rules:

1. `owner: 'multica'` updates the Multica issue assignee and lets Multica enqueue and execute the task. Orca displays Multica run state and logs but does not create an agent terminal for that issue.
2. `owner: 'orca'` does not assign a Multica agent. Orca creates or reuses the workspace, launches the selected Orca agent, and publishes lifecycle comments and issue-status transitions according to the sync policy.
3. `owner: 'manual'` links the issue for context only.
4. Changing owners while a run is active is rejected unless the active run is cancelled or explicitly detached.
5. Every launch includes an idempotency key derived from profile, workspace, issue, and Orca session identifiers.

For unmodified Multica instances, Orca stores cooperative bridge metadata through the public issue metadata API:

- `orca.execution_owner`
- `orca.workspace_id`
- `orca.session_id`
- `orca.idempotency_key`
- `orca.heartbeat_at`

The first release treats this as an advisory lease and verifies it immediately before launch and before every state mutation. A later optional Multica-side bridge endpoint can make the lease transactional without changing the Orca-domain interface.

### 4. Skills plane

The integration supports both directions without assuming the formats are identical.

- **Orca to Multica:** publish an Orca skill package as a Multica skill with a stable source identifier, manifest digest, and conflict policy (`fail`, `overwrite`, `rename`, or `skip`).
- **Multica to Orca:** materialize a Multica skill into an Orca managed skill directory with provenance metadata and a package digest.
- **Assignment:** attach Multica skills to Multica agents through the Multica API; attach Orca skills to Orca agent profiles through Orca's existing skill registry.
- **Launch context:** the bundled `orca-multica` skill teaches agents how to read issue context, add comments, update status, inspect runs, and respect execution ownership.

Skill synchronization is explicit and digest-based. It never overwrites a locally modified skill silently.

### 5. User interface and CLI plane

Orca exposes the same core capability through three surfaces:

- Runtime RPC for desktop, web, and remote clients.
- `orca multica ...` CLI commands for automation and agents.
- Native Settings and Tasks UI.

The first UI release includes:

- connection profiles and credential management;
- external versus managed instance mode;
- status, version, and capability diagnostics;
- lifecycle controls for managed instances;
- workspace/project/issue selection;
- issue detail, comments, runs, agents, and assignment;
- an execution-owner selector with explicit Multica/Orca/manual choices;
- Multica issue as a new-workspace source.

## Capability negotiation

Health checking produces a structured result rather than a boolean.

```ts
export type MulticaHealthState =
  | { kind: 'not-installed' }
  | { kind: 'compose-unavailable'; message: string }
  | { kind: 'not-running' }
  | { kind: 'unsupported-version'; message: string; detectedVersion?: string }
  | { kind: 'unreachable'; message: string }
  | { kind: 'authentication-failed'; message: string }
  | { kind: 'workspace-not-found'; workspaceId: string }
  | {
      kind: 'ready'
      checkedAt: number
      serverVersion?: string
      cliVersion?: string
      capabilities: MulticaCapability[]
    }
```

Capability discovery combines:

1. `GET /health` for reachability.
2. `GET /api/config` for server version and public configuration where available.
3. `GET /api/me` and a workspace-scoped lightweight query for authentication and workspace validation.
4. `multica version --output json` when a CLI execution target is configured.
5. Conservative feature probes for endpoints that are absent on older self-hosted releases.

A missing optional capability disables only the dependent feature. It does not make the whole profile unusable.

## Managed-instance lifecycle

Orca-managed deployments use an existing checked-out Multica deployment directory or a directory created by a later installer slice. The lifecycle runner supports:

- `docker compose config --quiet`
- `docker compose ps --format json`
- `docker compose up -d`
- `docker compose stop`
- `docker compose restart`
- `docker compose pull`
- `docker compose up -d --remove-orphans`
- bounded log retrieval for diagnostics

All compose files and environment files are stored as paths in non-secret Orca state. Secret environment values remain in a protected secret store or in the user-owned environment file. Orca never renders their contents in diagnostics.

`update` runs `pull` followed by `up -d --remove-orphans`, then waits for health readiness. It does not run destructive database commands.

## Security model

1. Tokens are referenced by opaque IDs in profile state.
2. Electron hosts use `safeStorage`; headless hosts use AES-256-GCM derived from `ORCA_MULTICA_MASTER_KEY`.
3. REST credentials are placed only in request headers.
4. CLI credentials are placed only in environment variables such as `MULTICA_TOKEN`.
5. No secret appears in argv, persisted state, structured errors, or agent launch context.
6. Process invocation uses `shell: false` and validated executable/argument arrays.
7. Output is byte-bounded before parsing and redacted before persistence or display.
8. Redirects from authenticated REST requests are rejected unless they remain on the same origin.
9. TLS verification remains enabled. Custom certificate authorities are supported through an explicit profile option in a later slice; insecure TLS is not.
10. Existing instances are read/write only within the authenticated user's Multica permissions.

## State and persistence

Orca stores Multica integration state under the host data directory:

```text
~/.orca/multica/state.json
~/.orca/multica/secrets.json.enc
```

The state document is versioned, size-bounded, normalized on read, and atomically written. It contains:

- profiles;
- repository bindings;
- workspace/issue bindings;
- execution policies;
- skill synchronization receipts;
- last-known capability snapshots.

Optional integration state is fail-closed for Multica operations but fail-open for unrelated Orca startup. A corrupted Multica state file must not prevent PTY, workspace, or Git functionality from starting.

## Error handling

Transport errors map to stable domain errors:

- `multica_not_installed`
- `multica_unreachable`
- `multica_authentication_failed`
- `multica_workspace_not_found`
- `multica_capability_missing`
- `multica_conflict`
- `multica_active_execution`
- `multica_output_too_large`
- `multica_invalid_response`
- `multica_instance_not_managed`

Retry behavior is narrow:

- GET and idempotent health probes may retry bounded transient network failures.
- Mutations retry only when the request has an idempotency key and the transport can prove that the server did not accept it, or when the endpoint itself supports idempotency.
- Agent launch is never retried blindly.

## Data flows

### Connect to an existing instance

1. User creates a REST profile and stores a PAT through stdin or the UI secret field.
2. Orca stores only a credential reference in state.
3. Health probes server, authentication, workspace, server version, and optional CLI version.
4. Capabilities are cached with a timestamp and refreshed before unsupported operations.

### Start an Orca-managed instance

1. User creates a Docker Compose lifecycle profile.
2. Orca validates paths and `docker compose config --quiet` on the selected execution host.
3. Orca optionally pulls images, starts services, and waits for `/health`.
4. The same REST profile is then validated and used for all data-plane operations.

### Execute with a Multica agent

1. Orca verifies no Orca-owned session is active for the issue.
2. Orca sets the issue assignee to a Multica agent or squad.
3. Multica owns the queued/running task.
4. Orca streams or polls run state and messages for display.

### Execute with an Orca agent

1. Orca verifies no Multica run is queued or active and acquires the cooperative metadata lease.
2. Orca creates or reuses a workspace linked to the Multica issue.
3. Orca launches the selected local/remote agent with non-secret Multica context.
4. Lifecycle events update metadata, comments, and optionally issue status.
5. Completion releases the lease and records the final Orca session identifier.

## Testing strategy

Each slice follows test-first development.

- Pure shared modules: Vitest unit tests for parsing, normalization, command construction, redaction, capability mapping, and execution policy transitions.
- Main-process modules: injected runners and HTTP clients; no real shell or network in unit tests.
- RPC: schema/registry tests and handler tests with fake services.
- CLI: command-spec/handler parity and stdin secret tests.
- Cross-host: invocation-envelope tests for local, WSL, SSH, and runtime targets.
- Managed instance: Docker Compose command-contract tests, plus an opt-in integration workflow using a disposable Multica Compose stack.
- Multica fork: Go tests for any optional bridge endpoint and existing full CI.
- End-to-end: create issue, choose execution owner, launch, observe comments/status/runs, and prevent double execution.

## Delivery slices

1. **Foundation:** profiles, protected credentials, host execution, REST health, capability negotiation, managed lifecycle, RPC, and CLI.
2. **Tracker:** workspaces, projects, issues, comments, labels, properties, search, and runs.
3. **Native Multica execution:** agents, squads, skills, runtimes, assignment, run observation, and cancellation.
4. **Orca-managed execution:** workspace source, advisory lease, session launch, status/comment synchronization, and conflict handling.
5. **Skills bridge:** import/export, provenance, digest receipts, and agent attachment.
6. **Native UI and realtime:** Settings, Tasks surface, execution-owner controls, WebSocket subscriptions, and polling fallback.
7. **Optional strong bridge API:** transactional execution lease and idempotent Orca-run registration in the Multica fork.

Each slice is developed in a short-lived branch, validated by the narrowest complete gate, and merged promptly into `main` before the next slice begins.
