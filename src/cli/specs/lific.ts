import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const LIFIC_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['lific', 'host-exec'],
    summary: 'Internal: execute a validated Lific process envelope on this host',
    usage: 'orca lific host-exec --envelope-stdin',
    allowedFlags: [...GLOBAL_FLAGS, 'envelope-stdin']
  },
  {
    path: ['lific', 'profiles'],
    summary: 'List host-scoped Lific connection profiles',
    usage: 'orca lific profiles [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['lific', 'profile', 'put'],
    summary: 'Create or update a Lific connection profile',
    usage:
      'orca lific profile put --id <id> --host <execution-host-id> --name <name> (--url <base-url> [--mcp-url <url>] | --db <path>) [--target current|wsl|ssh] [--wsl-distro <name>] [--ssh-host <destination>] [--ssh-port <n>] [--ssh-identity-file <path>] [--connection-id <id>] [--credential-ref <ref>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'id',
      'host',
      'name',
      'url',
      'mcp-url',
      'db',
      'target',
      'wsl-distro',
      'ssh-host',
      'ssh-port',
      'ssh-identity-file',
      'connection-id',
      'credential-ref'
    ]
  },
  {
    path: ['lific', 'credential', 'store'],
    summary: 'Store a Lific credential from stdin in the host vault',
    usage: 'orca lific credential store --ref <ref> --stdin [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref', 'stdin']
  },
  {
    path: ['lific', 'credential', 'delete'],
    aliases: [['lific', 'credential', 'rm']],
    summary: 'Delete a Lific credential from the host vault',
    usage: 'orca lific credential delete --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'ref']
  },
  {
    path: ['lific', 'status'],
    summary: 'Validate Lific on the selected execution host',
    usage: 'orca lific status --profile <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile']
  },
  {
    path: ['lific', 'bind-repo'],
    summary: 'Bind an Orca repository to a Lific project',
    usage:
      'orca lific bind-repo --repo <repo-id> --profile <id> [--project <identifier>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'profile', 'project']
  },
  {
    path: ['lific', 'bind-workspace'],
    summary: 'Bind an Orca workspace to a Lific issue',
    usage: 'orca lific bind-workspace --workspace <id> --issue <identifier> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'workspace', 'issue']
  },
  {
    path: ['lific', 'context'],
    summary: 'Read non-secret Lific context for an Orca workspace',
    usage:
      'orca lific context --repo <id> --agent-profile <id> --host <id> [--workspace <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'workspace', 'agent-profile', 'host']
  },
  {
    path: ['lific', 'connect'],
    summary: 'Preview or provision Lific for one Orca agent harness',
    usage:
      'orca lific connect --profile <id> --agent <agent> [--agent-profile <id>] [--scope global|project] [--oauth] [--dry-run] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'profile',
      'agent',
      'agent-profile',
      'scope',
      'oauth',
      'dry-run'
    ]
  },
  {
    path: ['lific', 'reconnect'],
    summary: 'Revoke and replace one Lific harness credential',
    usage:
      'orca lific reconnect --profile <id> --agent <agent> [--agent-profile <id>] [--scope global|project] [--oauth] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'agent', 'agent-profile', 'scope', 'oauth']
  },
  {
    path: ['lific', 'disconnect'],
    summary: 'Disconnect one Lific harness and remove its stored credential',
    usage: 'orca lific disconnect --profile <id> --agent-profile <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'agent-profile']
  },
  {
    path: ['lific', 'agents-md'],
    summary: 'Update a repository AGENTS.md with Lific guidance',
    usage: 'orca lific agents-md --profile <id> --path <path> [--project <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'path', 'project']
  },
  {
    path: ['lific', 'project', 'list'],
    summary: 'List Lific projects',
    usage: 'orca lific project list --profile <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile']
  },
  {
    path: ['lific', 'issue', 'list'],
    summary: 'List Lific issues for a project',
    usage:
      'orca lific issue list --profile <id> --project <identifier> [--query <text>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'project', 'query', 'limit']
  },
  {
    path: ['lific', 'issue', 'show'],
    summary: 'Show a Lific issue',
    usage: 'orca lific issue show --profile <id> --issue <identifier> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'issue']
  },
  {
    path: ['lific', 'issue', 'update'],
    summary: 'Update a Lific issue',
    usage:
      'orca lific issue update --profile <id> --issue <identifier> [--status <value>] [--title <text>] [--description <text>] [--priority <value>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'profile',
      'issue',
      'status',
      'title',
      'description',
      'priority'
    ]
  },
  {
    path: ['lific', 'comment', 'list'],
    summary: 'List comments on a Lific issue',
    usage: 'orca lific comment list --profile <id> --issue <identifier> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'issue']
  },
  {
    path: ['lific', 'comment', 'add'],
    summary: 'Add a comment to a Lific issue',
    usage:
      'orca lific comment add --profile <id> --issue <identifier> (--body <text> | --stdin) [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'issue', 'body', 'stdin']
  },
  {
    path: ['lific', 'plan', 'list'],
    summary: 'List Lific plans for a project',
    usage:
      'orca lific plan list --profile <id> --project-id <n> [--status <value>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'project-id', 'status']
  },
  {
    path: ['lific', 'plan', 'show'],
    summary: 'Show a Lific plan',
    usage: 'orca lific plan show --profile <id> --plan <identifier> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'plan']
  },
  {
    path: ['lific', 'plan-step', 'set'],
    summary: 'Update a Lific plan step',
    usage:
      'orca lific plan-step set --profile <id> --plan-id <n> --step-id <n> [--done true|false] [--title <text>] [--description <text>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'profile',
      'plan-id',
      'step-id',
      'done',
      'title',
      'description'
    ]
  },
  {
    path: ['lific', 'page', 'list'],
    summary: 'List Lific pages for a project',
    usage: 'orca lific page list --profile <id> --project-id <n> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'project-id']
  },
  {
    path: ['lific', 'page', 'show'],
    summary: 'Show a Lific page',
    usage: 'orca lific page show --profile <id> --page <identifier> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'page']
  },
  {
    path: ['lific', 'search'],
    summary: 'Search Lific issues and pages',
    usage:
      'orca lific search --profile <id> --query <text> [--project-id <n>] [--type issue|page] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'query', 'project-id', 'type', 'limit']
  },
  {
    path: ['lific', 'board'],
    summary: 'Read a Lific project board',
    usage: 'orca lific board --profile <id> --project-id <n> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'project-id']
  },
  {
    path: ['lific', 'relation', 'add'],
    summary: 'Link two Lific issues',
    usage:
      'orca lific relation add --profile <id> --source <issue> --target <issue> --type <relation> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'source', 'target', 'type']
  },
  {
    path: ['lific', 'relation', 'remove'],
    aliases: [['lific', 'relation', 'rm']],
    summary: 'Unlink two Lific issues',
    usage:
      'orca lific relation remove --profile <id> --source <issue> --target <issue> --type <relation> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'source', 'target', 'type']
  },
  {
    path: ['lific', 'activity'],
    summary: 'Read a Lific project activity feed',
    usage:
      'orca lific activity --profile <id> --project-id <n> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'profile', 'project-id', 'limit']
  }
]
