import type { LificClientId, LificScope } from './lific-types'

export type LificClientDefinition = {
  id: LificClientId
  displayName: string
  scopes: readonly LificScope[]
  transports: readonly ('http-key' | 'http-oauth' | 'stdio')[]
  credentialDelivery: 'inline-header' | 'environment' | 'none'
  credentialEnvironmentVariable?: string
}

const CLIENTS: readonly LificClientDefinition[] = [
  {
    id: 'opencode',
    displayName: 'OpenCode',
    scopes: ['global', 'project'],
    transports: ['http-key', 'http-oauth', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    scopes: ['global', 'project'],
    transports: ['http-key', 'http-oauth', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'claude-desktop',
    displayName: 'Claude Desktop',
    scopes: ['global'],
    transports: ['http-key', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    scopes: ['global', 'project'],
    transports: ['http-key', 'http-oauth', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'vscode',
    displayName: 'VS Code',
    scopes: ['global', 'project'],
    transports: ['http-key', 'http-oauth', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'codex',
    displayName: 'Codex',
    scopes: ['global', 'project'],
    transports: ['http-key', 'http-oauth', 'stdio'],
    credentialDelivery: 'environment',
    credentialEnvironmentVariable: 'LIFIC_API_KEY'
  },
  {
    id: 'zed',
    displayName: 'Zed',
    scopes: ['global'],
    transports: ['http-key', 'http-oauth', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    scopes: ['global', 'project'],
    transports: ['http-key', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'windsurf',
    displayName: 'Windsurf',
    scopes: ['global'],
    transports: ['http-key', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'goose',
    displayName: 'Goose',
    scopes: ['global'],
    transports: ['http-key', 'stdio'],
    credentialDelivery: 'inline-header'
  },
  {
    id: 'crush',
    displayName: 'Crush',
    scopes: ['global', 'project'],
    transports: ['http-key', 'stdio'],
    credentialDelivery: 'inline-header'
  }
] as const

const CLIENT_BY_ID = new Map<LificClientId, LificClientDefinition>(
  CLIENTS.map((entry) => [entry.id, entry])
)

const AGENT_TO_CLIENT: Readonly<Record<string, LificClientId>> = {
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  gemini: 'gemini',
  goose: 'goose',
  crush: 'crush',
  cursor: 'cursor'
}

export function allLificClients(): readonly LificClientDefinition[] {
  return CLIENTS
}

export function findLificClient(id: string): LificClientDefinition | null {
  return CLIENT_BY_ID.get(id as LificClientId) ?? null
}

export function resolveLificClientForAgent(agent: string): LificClientId | null {
  return AGENT_TO_CLIENT[agent] ?? null
}

export function validateExplicitClientOverride(value: string): LificClientId {
  const client = findLificClient(value)
  if (!client) {
    throw new Error(
      `Unknown Lific client '${value}'. Known clients: ${CLIENTS.map((entry) => entry.id).join(', ')}`
    )
  }
  return client.id
}
