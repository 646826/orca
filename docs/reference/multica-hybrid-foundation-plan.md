# Multica Hybrid Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the secure, host-aware connection, health, capability, and managed-instance lifecycle foundation required by every later Multica tracker and execution feature.

**Architecture:** Mirror Orca's proven Lific host/secret/RPC pattern, but keep Multica data-plane and lifecycle concerns separate. REST is the preferred data plane; the Multica CLI is an optional compatibility and host-local fallback. Managed lifecycle actions use validated Docker Compose argv with `shell: false` and never contain credentials.

**Tech Stack:** TypeScript, Zod, Node `fetch`, Electron `safeStorage`, AES-256-GCM, Vitest, Orca runtime RPC, Orca CLI command registry.

## Global Constraints

- Support existing Multica Cloud and self-hosted instances without requiring server patches.
- Support Orca-managed Docker Compose instances on local, WSL, SSH, and Orca runtime hosts.
- Never place Multica credentials in argv, ordinary state, logs, workspace metadata, or launch context.
- Use `shell: false` for every child process.
- Preserve unrelated Orca startup when optional Multica state is missing or corrupt.
- Keep remote wire compatibility explicit through a new runtime capability.
- Use focused file names and keep project max-line gates enabled.
- Follow `docs/STYLEGUIDE.md` for later UI work; this foundation plan does not add UI.
- Commit each task independently and merge only after its complete relevant gate passes.

---

## File structure

### Shared domain

- `src/shared/multica/multica-types.ts`: stable profile, lifecycle, health, capability, invocation, and service types.
- `src/shared/multica/multica-state.ts`: bounded state parsing, normalization, and immutable upserts.
- `src/shared/multica/multica-secret-file.ts`: encrypted-file schema and safe secret-reference validation.
- `src/shared/multica/multica-redaction.ts`: token, Authorization header, URL credential, and environment-value redaction.
- `src/shared/multica/multica-host-envelope.ts`: bounded serializable remote execution envelope.
- `src/shared/multica/multica-rpc-contract.ts`: Zod schemas shared by runtime RPC and clients.

### Main process

- `src/main/multica/multica-state-store.ts`: atomic host-scoped integration state.
- `src/main/multica/multica-secret-store.ts`: safeStorage/AES-256-GCM protected credentials.
- `src/main/multica/multica-compose-commands.ts`: pure Docker Compose argv builders.
- `src/main/multica/multica-command-runner.ts`: bounded local process runner.
- `src/main/multica/multica-execution-host.ts`: local/WSL/SSH/runtime dispatch using the validated envelope.
- `src/main/multica/multica-rest-client.ts`: origin-pinned authenticated JSON requests.
- `src/main/multica/multica-health.ts`: server/CLI/workspace capability negotiation.
- `src/main/multica/multica-runtime-service.ts`: profile, credential, health, and lifecycle orchestration.
- `src/main/runtime/rpc/methods/multica.ts`: runtime RPC methods.

### CLI and protocol

- `src/cli/specs/multica.ts`: foundation CLI command specifications.
- `src/cli/handlers/multica.ts`: foundation CLI handlers.
- `src/shared/protocol-version.ts`: `multica.hybrid-foundation.v1` capability.
- `src/main/runtime/rpc/methods/index.ts`: register the Multica RPC group.
- `src/cli/specs/index.ts`: register Multica commands.
- `src/cli/handler-group-manifest.ts`: register lazy handlers.

### Tests

- `src/shared/multica/multica-state.test.ts`
- `src/shared/multica/multica-secret-file.test.ts`
- `src/shared/multica/multica-redaction.test.ts`
- `src/main/multica/multica-compose-commands.test.ts`
- `src/main/multica/multica-health.test.ts`
- `src/main/multica/multica-rest-client.test.ts`
- `src/main/runtime/rpc/methods/multica.test.ts`
- Extend `src/cli/handler-group-manifest.test.ts` through the production registry, not a duplicate fixture.

---

### Task 1: Shared profile and state contract

**Files:**
- Create: `src/shared/multica/multica-types.ts`
- Create: `src/shared/multica/multica-state.ts`
- Create: `src/shared/multica/multica-state.test.ts`

**Interfaces:**
- Produces: `MulticaConnectionProfile`, `MulticaDataPlane`, `MulticaInstanceLifecycle`, `MulticaExecutionTarget`, `MulticaHealthState`, `MulticaCapability`, `MulticaState`, `MulticaProfileInput`, `parseMulticaStateFile()`, `normalizeMulticaState()`, `upsertMulticaProfile()`.
- Consumed by: every later task in this plan.

- [ ] **Step 1: Write failing state tests**

Cover all of the following in `multica-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  MULTICA_STATE_FILE_MAX_BYTES,
  normalizeMulticaState,
  parseMulticaStateFile,
  upsertMulticaProfile
} from './multica-state'

describe('Multica state', () => {
  it('returns schema version 1 with empty collections for unknown input', () => {
    expect(normalizeMulticaState(null)).toEqual({
      schemaVersion: 1,
      profiles: [],
      repoBindings: [],
      workspaceBindings: [],
      skillReceipts: []
    })
  })

  it('rejects invalid JSON and unsupported schema versions', () => {
    expect(() => parseMulticaStateFile('{')).toThrow('invalid JSON')
    expect(() => parseMulticaStateFile('{"schemaVersion":2}')).toThrow(
      "Unsupported Multica state schema version '2'"
    )
  })

  it('rejects a document larger than MULTICA_STATE_FILE_MAX_BYTES', () => {
    expect(() => parseMulticaStateFile('x'.repeat(MULTICA_STATE_FILE_MAX_BYTES + 1))).toThrow(
      'Multica state exceeds'
    )
  })

  it('replaces one profile without changing unrelated profiles', () => {
    const first = createRestProfile('first')
    const second = createRestProfile('second')
    const updated = { ...first, displayName: 'Updated' }
    expect(upsertMulticaProfile(upsertMulticaProfile(normalizeMulticaState(null), first), second))
      .toMatchObject({ profiles: [first, second] })
    expect(upsertMulticaProfile({
      ...normalizeMulticaState(null),
      profiles: [first, second]
    }, updated).profiles).toEqual([second, updated])
  })
})
```

The local `createRestProfile()` test helper must return a complete profile with an external lifecycle and an opaque credential reference.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run --config config/vitest.config.ts src/shared/multica/multica-state.test.ts
```

Expected: FAIL because the Multica modules do not exist.

- [ ] **Step 3: Implement the minimal domain and state modules**

Use a 2 MiB state limit, schema version `1`, record-array normalization, and immutable upserts. Do not validate transport URLs in this persistence layer; URL validation belongs to RPC/service boundaries.

- [ ] **Step 4: Run the state test and the max-line gate**

```bash
pnpm exec vitest run --config config/vitest.config.ts src/shared/multica/multica-state.test.ts
pnpm run check:max-lines-ratchet
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/multica/multica-types.ts \
  src/shared/multica/multica-state.ts \
  src/shared/multica/multica-state.test.ts
git commit -m "feat(multica): add hybrid profile state contract"
```

---

### Task 2: Protected credential file contract and redaction

**Files:**
- Create: `src/shared/multica/multica-secret-file.ts`
- Create: `src/shared/multica/multica-secret-file.test.ts`
- Create: `src/shared/multica/multica-redaction.ts`
- Create: `src/shared/multica/multica-redaction.test.ts`

**Interfaces:**
- Produces: `assertMulticaSecretReference()`, `parseMulticaSecretFile()`, `emptyMulticaSecretFile()`, `redactMulticaSecrets()`.
- Consumed by: state/secret store, process runner, REST client, health mapper.

- [ ] **Step 1: Write failing secret-reference tests**

Verify empty, whitespace-padded, over-256-character, `__proto__`, `prototype`, and `constructor` references are rejected; `multica:profile:production` is accepted.

- [ ] **Step 2: Write failing redaction tests**

Verify all of these are absent from output:

```text
mul_abcdefghijklmnopqrstuvwxyz0123456789
mat_abcdefghijklmnopqrstuvwxyz0123456789
Authorization: Bearer secret-value
MULTICA_TOKEN=secret-value
https://user:password@example.com/path
```

The replacement text must preserve enough context to diagnose which field was redacted without preserving the value.

- [ ] **Step 3: Run both tests and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/multica/multica-secret-file.test.ts \
  src/shared/multica/multica-redaction.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement versioned, bounded parsing and deterministic redaction**

Use the same ciphertext providers as Lific:

```ts
type MulticaStoredCiphertext =
  | { provider: 'electron-safe-storage-v1'; data: string }
  | { provider: 'aes-256-gcm-v1'; data: string; iv: string; tag: string }
```

Use a 5 MiB file limit. Redaction must handle PAT prefixes, Authorization headers, known Multica token environment variables, and URL userinfo.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/multica/multica-secret-file.test.ts \
  src/shared/multica/multica-redaction.test.ts
git add src/shared/multica
git commit -m "feat(multica): protect and redact credentials"
```

---

### Task 3: Host state and secret stores

**Files:**
- Create: `src/main/multica/multica-state-store.ts`
- Create: `src/main/multica/multica-secret-store.ts`
- Create: `src/main/multica/multica-state-store.test.ts`
- Create: `src/main/multica/multica-secret-store.test.ts`

**Interfaces:**
- Produces: `resolveMulticaDataDirectory()`, `MulticaStateStore`, `OrcaMulticaSecretStore`.
- Consumes: shared state/secret contracts and `writeSecureFile()`.

- [ ] **Step 1: Write failing state-store tests**

Use a temporary directory. Verify missing files return empty state, `putProfile()` persists, concurrent writes serialize, and an oversized serialized document is rejected.

- [ ] **Step 2: Write failing AES secret-store tests**

Set `ORCA_MULTICA_MASTER_KEY` to a deterministic 32+ character test value. Verify set/get/delete, ciphertext never contains plaintext, and decryption without the key fails closed.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-state-store.test.ts \
  src/main/multica/multica-secret-store.test.ts
```

- [ ] **Step 4: Implement stores**

Default paths:

```text
${ORCA_MULTICA_DATA_DIR}
${ORCA_DATA_DIR}/multica
~/.orca/multica
```

Use `state.json` and `secrets.json.enc`. Mirror Lific's write-chain and protected-provider behavior but use Multica-specific environment names and errors.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-state-store.test.ts \
  src/main/multica/multica-secret-store.test.ts
git add src/main/multica src/shared/multica
git commit -m "feat(multica): persist host profiles and secrets"
```

---

### Task 4: Shell-free Docker Compose lifecycle commands

**Files:**
- Create: `src/main/multica/multica-compose-commands.ts`
- Create: `src/main/multica/multica-compose-commands.test.ts`

**Interfaces:**
- Produces: `buildMulticaComposeInvocation(action, lifecycle)` and `MulticaLifecycleAction`.
- Consumed by: runtime service and execution-host dispatch.

- [ ] **Step 1: Write failing table-driven command tests**

Expected command arrays:

```ts
config:  ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'config', '--quiet']
status:  ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'ps', '--format', 'json']
start:   ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'up', '-d']
stop:    ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'stop']
restart: ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'restart']
pull:    ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'pull']
apply:   ['compose', '-f', 'compose.yml', '--env-file', '.env', '-p', 'team', 'up', '-d', '--remove-orphans']
```

Every invocation must use command `docker`, lifecycle working directory, and `shell: false`. Multiple compose files repeat `-f` in order.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-compose-commands.test.ts
```

- [ ] **Step 3: Implement the pure builder**

Reject external lifecycle profiles, blank paths, newline-containing values, and more than eight compose files. Do not accept arbitrary extra arguments.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-compose-commands.test.ts
git add src/main/multica/multica-compose-commands*
git commit -m "feat(multica): build safe compose lifecycle commands"
```

---

### Task 5: Bounded process execution and remote host envelope

**Files:**
- Create: `src/shared/multica/multica-host-envelope.ts`
- Create: `src/shared/multica/multica-host-envelope.test.ts`
- Create: `src/main/multica/multica-command-runner.ts`
- Create: `src/main/multica/multica-command-runner.test.ts`
- Create: `src/main/multica/multica-execution-host.ts`
- Create: `src/main/multica/multica-execution-host.test.ts`

**Interfaces:**
- Produces: `MulticaProcessInvocation`, `MulticaProcessResult`, `MulticaCommandRunner`, `encodeMulticaHostEnvelope()`, `decodeMulticaHostEnvelope()`, `runMulticaOnExecutionHost()`.
- Consumes: Orca WSL/SSH/runtime execution primitives used by Lific.

- [ ] **Step 1: Write failing envelope tests**

Verify a valid invocation round-trips; shell values other than `false`, oversized envelopes, NUL bytes, unapproved environment keys, and more than 128 args are rejected.

Approved environment keys in the foundation are:

```text
MULTICA_TOKEN
MULTICA_SERVER_URL
MULTICA_WORKSPACE_ID
MULTICA_PROFILE
```

- [ ] **Step 2: Write failing runner tests**

Inject a fake spawn implementation and verify timeout, stdout/stderr byte caps, ENOENT mapping, environment inheritance, stdin delivery, and redacted failure output.

- [ ] **Step 3: Write failing host-routing tests**

Assert local, WSL, SSH, and runtime targets use the same validated envelope and preserve command/argv/cwd without constructing a shell string.

- [ ] **Step 4: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/multica/multica-host-envelope.test.ts \
  src/main/multica/multica-command-runner.test.ts \
  src/main/multica/multica-execution-host.test.ts
```

- [ ] **Step 5: Implement and verify GREEN**

Use a 10 MiB combined output cap, a 60-second default timeout, and process-tree termination consistent with Orca's existing host execution code.

- [ ] **Step 6: Commit**

```bash
git add src/shared/multica src/main/multica
git commit -m "feat(multica): execute safely across Orca hosts"
```

---

### Task 6: Origin-pinned REST client

**Files:**
- Create: `src/main/multica/multica-rest-client.ts`
- Create: `src/main/multica/multica-rest-client.test.ts`

**Interfaces:**
- Produces: `MulticaRestClient`, `MulticaHttpError`, `MulticaRestClientOptions`.
- Consumed by: health and later tracker clients.

- [ ] **Step 1: Write failing request tests**

Using an injected `fetch` implementation, verify:

- base URL normalization;
- `Authorization: Bearer <token>`;
- `X-Workspace-ID` only when configured;
- `Accept: application/json` and Orca client identity headers;
- JSON decoding with a 10 MiB response limit;
- 204 responses;
- mapped HTTP errors with redacted bodies;
- rejection of cross-origin redirects;
- bounded retries only for GET requests on transient transport failures.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-rest-client.test.ts
```

- [ ] **Step 3: Implement minimal client**

Do not add tracker endpoint methods yet. Implement generic `getJson`, `postJson`, `patchJson`, `putJson`, and `deleteJson` methods with injected fetch and explicit timeout signals.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-rest-client.test.ts
git add src/main/multica/multica-rest-client*
git commit -m "feat(multica): add secure REST transport"
```

---

### Task 7: Health and capability negotiation

**Files:**
- Create: `src/main/multica/multica-health.ts`
- Create: `src/main/multica/multica-health.test.ts`

**Interfaces:**
- Produces: `probeMulticaHealth()`.
- Consumes: profile, secret, REST client, optional command runner, and lifecycle status.

- [ ] **Step 1: Write failing scenario tests**

Cover:

1. external REST instance ready with server version;
2. invalid PAT maps to `authentication-failed`;
3. configured workspace missing maps to `workspace-not-found`;
4. unreachable origin maps to `unreachable` with redacted message;
5. CLI ENOENT maps to `not-installed` only when CLI is required;
6. managed compose service stopped maps to `not-running`;
7. unavailable Docker Compose maps to `compose-unavailable`;
8. older server keeps the profile ready but omits unsupported capabilities;
9. current server advertises tracker, agents, skills, runs, and lifecycle capabilities.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-health.test.ts
```

- [ ] **Step 3: Implement the ordered probe**

Probe lifecycle first for managed profiles, then `/health`, `/api/config`, `/api/me`, configured workspace access, and optional `multica version --output json`. Feature probes must be conservative and separately mapped.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-health.test.ts
git add src/main/multica/multica-health*
git commit -m "feat(multica): negotiate instance capabilities"
```

---

### Task 8: Runtime service and lifecycle orchestration

**Files:**
- Create: `src/main/multica/multica-runtime-service.ts`
- Create: `src/main/multica/multica-runtime-service.test.ts`

**Interfaces:**
- Produces: `MulticaRuntimeService`, `getMulticaRuntimeService()`.
- Consumes: state store, secret store, host executor, compose builder, REST client, health probe.

- [ ] **Step 1: Write failing service tests**

Verify:

- profile put strips stale validation fields;
- status resolves credential references without returning token material;
- external profiles reject lifecycle mutation with `multica_instance_not_managed`;
- start validates compose config, optionally pulls, starts, and polls health;
- stop and restart dispatch exactly once;
- update performs pull then apply and waits for health;
- profile execution-host mismatch fails before any command or request;
- all returned profile objects remain secret-free.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-runtime-service.test.ts
```

- [ ] **Step 3: Implement service**

Use injected dependencies in the class constructor. Keep the singleton factory in the same file and instantiate production dependencies lazily.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/multica/multica-runtime-service.test.ts
git add src/main/multica/multica-runtime-service*
git commit -m "feat(multica): orchestrate profiles and lifecycle"
```

---

### Task 9: RPC contract and runtime methods

**Files:**
- Create: `src/shared/multica/multica-rpc-contract.ts`
- Create: `src/main/runtime/rpc/methods/multica.ts`
- Create: `src/main/runtime/rpc/methods/multica.test.ts`
- Modify: `src/main/runtime/rpc/methods/index.ts`
- Modify: `src/shared/protocol-version.ts`

**Interfaces:**
- Produces RPC methods:
  - `multica.profiles`
  - `multica.profile.put`
  - `multica.credential.store`
  - `multica.credential.delete`
  - `multica.status`
  - `multica.instance.validate`
  - `multica.instance.start`
  - `multica.instance.stop`
  - `multica.instance.restart`
  - `multica.instance.update`
- Produces runtime capability: `multica.hybrid-foundation.v1`.

- [ ] **Step 1: Write failing schema and handler tests**

Verify URL schemes are `http:` or `https:`, IDs and names are trimmed/non-empty, compose files are bounded, credentials are accepted only as a runtime value and never returned, and external profiles cannot invoke managed actions.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/rpc/methods/multica.test.ts
```

- [ ] **Step 3: Implement schemas and methods**

Follow `lific.ts`'s `defineMethod()` registration style. Store credentials through the service from an RPC parameter, but return only `{ stored: true, reference }`.

- [ ] **Step 4: Register method group and capability**

Add `MULTICA_METHODS` adjacent to `LIFIC_METHODS`. Append `MULTICA_HYBRID_FOUNDATION_RUNTIME_CAPABILITY` to the advertised capability list without changing the existing protocol version number.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/rpc/methods/multica.test.ts
pnpm run typecheck:node
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/multica src/main/runtime/rpc src/shared/protocol-version.ts
git commit -m "feat(multica): expose foundation runtime RPC"
```

---

### Task 10: Orca CLI foundation surface

**Files:**
- Create: `src/cli/specs/multica.ts`
- Create: `src/cli/handlers/multica.ts`
- Create: `src/cli/handlers/multica.test.ts`
- Modify: `src/cli/specs/index.ts`
- Modify: `src/cli/handler-group-manifest.ts`

**Interfaces:**
- Produces commands:
  - `orca multica profiles`
  - `orca multica profile put`
  - `orca multica credential store --stdin`
  - `orca multica credential delete`
  - `orca multica status`
  - `orca multica instance validate`
  - `orca multica instance start`
  - `orca multica instance stop`
  - `orca multica instance restart`
  - `orca multica instance update`

- [ ] **Step 1: Write failing handler tests**

Use a fake RPC client. Verify complete profile construction for REST/external and REST/docker-compose modes, stdin-only credential storage, JSON output, human output, and missing required flags.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/cli/handlers/multica.test.ts \
  src/cli/handler-group-manifest.test.ts
```

- [ ] **Step 3: Implement command specs and handlers**

Credential store usage must be:

```text
orca multica credential store --ref <ref> --stdin
```

Profile put must support:

```text
--id --host --name --server-url --app-url --workspace --credential-ref
--target current|wsl|ssh|runtime
--wsl-distro --ssh-host --ssh-port --ssh-identity-file --connection-id --environment-id
--managed-compose-dir --compose-file (repeatable) --env-file --project-name --pull-before-start
--cli --cli-profile
```

Do not accept a token flag.

- [ ] **Step 4: Register specs and handler group**

Add one lazy group named `multica`; ensure `keys` exactly match the exported handler record.

- [ ] **Step 5: Run focused CLI tests and typecheck**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/cli/handlers/multica.test.ts \
  src/cli/handler-group-manifest.test.ts
pnpm run typecheck:cli
```

- [ ] **Step 6: Commit**

```bash
git add src/cli
git commit -m "feat(multica): add foundation CLI commands"
```

---

### Task 11: Foundation integration gate and merge

**Files:**
- Review all files created or modified by Tasks 1-10.

- [ ] **Step 1: Run the focused Multica suite**

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/multica \
  src/main/multica \
  src/main/runtime/rpc/methods/multica.test.ts \
  src/cli/handlers/multica.test.ts \
  src/cli/handler-group-manifest.test.ts
```

Expected: all tests pass with zero unhandled errors.

- [ ] **Step 2: Run static gates**

```bash
pnpm run typecheck
pnpm exec oxlint --format github src/shared/multica src/main/multica \
  src/main/runtime/rpc/methods/multica.ts src/cli/specs/multica.ts src/cli/handlers/multica.ts
pnpm run check:max-lines-ratchet
pnpm run check:reliability-gates
pnpm run check:code-quality:changed
```

Expected: exit code 0 for every command.

- [ ] **Step 3: Verify the diff**

```bash
git diff --check main...HEAD
git status --short
git log --oneline main..HEAD
```

Expected: no whitespace errors, clean worktree, and only the task commits listed above.

- [ ] **Step 4: Open a non-draft PR**

The PR body must list the exact commands from Steps 1-3 and explicitly state that tracker data, agent assignment, and UI are follow-up slices rather than hidden partial implementations.

- [ ] **Step 5: Merge after GitHub checks complete**

Use squash merge only if the repository policy expects one commit per vertical slice; otherwise preserve the atomic task commits with a merge commit. Confirm `main` points to the merge result and run the relevant post-merge workflow before claiming completion.
