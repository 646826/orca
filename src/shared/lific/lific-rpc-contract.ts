import { z } from 'zod'
import {
  LIFIC_PROVISIONING_RUNTIME_CAPABILITY,
  LIFIC_TASK_PROVIDER_RUNTIME_CAPABILITY
} from '../protocol-version'

export { LIFIC_PROVISIONING_RUNTIME_CAPABILITY, LIFIC_TASK_PROVIDER_RUNTIME_CAPABILITY }

const NonEmpty = z.string().trim().min(1)
const OptionalNonEmpty = NonEmpty.optional()

export const LificClientIdSchema = z.enum([
  'opencode',
  'claude-code',
  'claude-desktop',
  'cursor',
  'vscode',
  'codex',
  'zed',
  'gemini',
  'windsurf',
  'goose',
  'crush'
])

export const LificScopeSchema = z.enum(['global', 'project'])

export const LificHealthStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-installed') }).strict(),
  z.object({ kind: z.literal('unsupported-version'), message: NonEmpty }).strict(),
  z.object({ kind: z.literal('not-initialized') }).strict(),
  z.object({ kind: z.literal('not-configured') }).strict(),
  z.object({ kind: z.literal('unreachable'), message: NonEmpty }).strict(),
  z.object({ kind: z.literal('authentication-failed'), message: NonEmpty }).strict(),
  z.object({ kind: z.literal('unsupported-agent'), agent: NonEmpty }).strict(),
  z.object({ kind: z.literal('ready'), checkedAt: z.number().int().nonnegative() }).strict()
])

export const LificTransportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdio'), databasePath: NonEmpty }).strict(),
  z
    .object({
      kind: z.literal('http'),
      baseUrl: NonEmpty.url(),
      mcpUrl: NonEmpty.url()
    })
    .strict()
])

export const LificManagementAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-instance') }).strict(),
  z.object({ kind: z.literal('stored-oauth'), credentialRef: NonEmpty }).strict(),
  z.object({ kind: z.literal('external-key'), credentialRef: NonEmpty }).strict()
])

export const LificExecutionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), id: NonEmpty }).strict(),
  z
    .object({
      kind: z.literal('wsl'),
      id: NonEmpty,
      distribution: NonEmpty,
      helperCommand: OptionalNonEmpty
    })
    .strict(),
  z
    .object({
      kind: z.literal('ssh'),
      id: NonEmpty,
      connectionId: NonEmpty,
      host: NonEmpty,
      port: z.number().int().min(1).max(65535).optional(),
      identityFile: OptionalNonEmpty,
      helperCommand: OptionalNonEmpty
    })
    .strict(),
  z.object({ kind: z.literal('runtime'), id: NonEmpty, environmentId: NonEmpty }).strict()
])

export const LificConnectionProfileSchema = z
  .object({
    id: NonEmpty,
    executionHostId: NonEmpty,
    displayName: NonEmpty,
    transport: LificTransportSchema,
    managementAuth: LificManagementAuthSchema,
    executionTarget: LificExecutionTargetSchema.optional(),
    managedByOrca: z.boolean(),
    lastValidatedAt: z.number().int().nonnegative().optional(),
    lastValidationState: LificHealthStateSchema.optional()
  })
  .strict()

export const LificProfilePutSchema = z.object({ profile: LificConnectionProfileSchema }).strict()
export const LificProfileIdSchema = z.object({ profileId: NonEmpty }).strict()
export const LificStatusSchema = z
  .object({ profileId: NonEmpty, force: z.boolean().optional() })
  .strict()
export const LificStoreCredentialSchema = z
  .object({ credentialRef: NonEmpty, value: NonEmpty })
  .strict()
export const LificDeleteCredentialSchema = z.object({ credentialRef: NonEmpty }).strict()

export const LificRepoBindSchema = z
  .object({
    repoId: NonEmpty,
    connectionProfileId: NonEmpty,
    projectIdentifier: OptionalNonEmpty,
    agentsMdMode: z.enum(['off', 'offer', 'managed']).default('offer')
  })
  .strict()

export const LificWorkspaceBindSchema = z
  .object({ workspaceId: NonEmpty, issueIdentifier: NonEmpty })
  .strict()

export const LificContextSchema = z
  .object({
    repoId: NonEmpty,
    workspaceId: OptionalNonEmpty,
    agentProfileId: NonEmpty,
    executionHostId: NonEmpty
  })
  .strict()

export const LificConnectSchema = z
  .object({
    profileId: NonEmpty,
    agent: NonEmpty,
    agentProfileId: NonEmpty,
    scope: LificScopeSchema,
    authentication: z.enum(['bot', 'oauth']).default('bot'),
    dryRun: z.boolean().default(false),
    cwd: OptionalNonEmpty
  })
  .strict()

export const LificDisconnectSchema = z
  .object({ profileId: NonEmpty, agentProfileId: NonEmpty })
  .strict()

export const LificAgentsMdSchema = z
  .object({ profileId: NonEmpty, path: NonEmpty, projectIdentifier: OptionalNonEmpty })
  .strict()

export const LificIssueListSchema = z
  .object({
    profileId: NonEmpty,
    project: NonEmpty,
    query: OptionalNonEmpty,
    limit: z.number().int().min(1).max(500).optional()
  })
  .strict()
export const LificIssueGetSchema = z.object({ profileId: NonEmpty, identifier: NonEmpty }).strict()
export const LificIssueUpdateSchema = z
  .object({ profileId: NonEmpty, identifier: NonEmpty, update: z.record(z.string(), z.unknown()) })
  .strict()
export const LificCommentAddSchema = z
  .object({ profileId: NonEmpty, identifier: NonEmpty, content: NonEmpty.max(20000) })
  .strict()
export const LificPlanListSchema = z
  .object({ profileId: NonEmpty, projectId: z.number().int().positive(), status: OptionalNonEmpty })
  .strict()
export const LificPlanGetSchema = z.object({ profileId: NonEmpty, identifier: NonEmpty }).strict()
export const LificPlanStepUpdateSchema = z
  .object({
    profileId: NonEmpty,
    planId: z.number().int().positive(),
    stepId: z.number().int().positive(),
    update: z.record(z.string(), z.unknown())
  })
  .strict()
export const LificActivitySchema = z
  .object({
    profileId: NonEmpty,
    projectId: z.number().int().positive(),
    limit: z.number().int().min(1).max(500).optional()
  })
  .strict()
export const LificSearchSchema = z
  .object({
    profileId: NonEmpty,
    query: NonEmpty,
    projectId: z.number().int().positive().optional(),
    resultType: z.enum(['issue', 'page']).optional(),
    limit: z.number().int().min(1).max(500).optional()
  })
  .strict()
export const LificPageListSchema = z
  .object({ profileId: NonEmpty, projectId: z.number().int().positive() })
  .strict()
export const LificPageGetSchema = z.object({ profileId: NonEmpty, identifier: NonEmpty }).strict()
export const LificBoardSchema = z
  .object({ profileId: NonEmpty, projectId: z.number().int().positive() })
  .strict()
export const LificRelationSchema = z
  .object({
    profileId: NonEmpty,
    source: NonEmpty,
    target: NonEmpty,
    relation: NonEmpty
  })
  .strict()
