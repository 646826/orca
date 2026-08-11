import { translate } from '@/i18n/i18n'

export const lificCopy = {
  brand: (): string => translate('settings.lific.brand', 'Lific'),
  description: (): string =>
    translate(
      'settings.lific.description',
      'Host-aware MCP, persistent plans, issue context and native Tasks for this project.'
    ),
  executionHost: (host: string): string =>
    translate('settings.lific.executionHost', 'Execution host: {{host}}', { host }),
  refreshStatus: (): string => translate('settings.lific.refreshStatus', 'Refresh Lific status'),

  executionTarget: (): string =>
    translate('settings.lific.profile.executionTarget', 'Execution target'),
  currentRuntime: (): string =>
    translate('settings.lific.profile.currentRuntime', 'Current Orca runtime'),
  wslDistribution: (): string =>
    translate('settings.lific.profile.wslDistribution', 'WSL distribution'),
  sshHost: (): string => translate('settings.lific.profile.sshHost', 'SSH host'),
  sshDestination: (): string =>
    translate('settings.lific.profile.sshDestination', 'SSH destination'),
  sshDestinationPlaceholder: (): string =>
    translate('settings.lific.profile.sshDestinationPlaceholder', 'user@example.com'),
  sshPort: (): string => translate('settings.lific.profile.sshPort', 'SSH port'),
  identityFile: (): string => translate('settings.lific.profile.identityFile', 'Identity file'),
  optionalPath: (): string => translate('settings.lific.profile.optionalPath', 'Optional path'),
  connectionMode: (): string =>
    translate('settings.lific.profile.connectionMode', 'Connection mode'),
  httpServer: (): string => translate('settings.lific.profile.httpServer', 'HTTP server'),
  localStdio: (): string => translate('settings.lific.profile.localStdio', 'Local SQLite / stdio'),
  agentHarness: (): string => translate('settings.lific.profile.agentHarness', 'Agent harness'),
  serverUrl: (): string => translate('settings.lific.profile.serverUrl', 'Server URL'),
  mcpUrl: (): string => translate('settings.lific.profile.mcpUrl', 'MCP URL'),
  managementCredential: (): string =>
    translate('settings.lific.profile.managementCredential', 'Management credential'),
  protectedCredentialPlaceholder: (): string =>
    translate(
      'settings.lific.profile.protectedCredentialPlaceholder',
      'Stored encrypted; never returned to renderer'
    ),
  agentAuthentication: (): string =>
    translate('settings.lific.profile.agentAuthentication', 'Agent authentication'),
  perHarnessBot: (): string =>
    translate('settings.lific.profile.perHarnessBot', 'Per-harness bot (recommended)'),
  oauthHeaderless: (): string =>
    translate('settings.lific.profile.oauthHeaderless', 'OAuth / headerless'),
  databasePath: (): string =>
    translate('settings.lific.profile.databasePath', 'Lific database path on this host'),
  projectIdentifier: (): string =>
    translate('settings.lific.profile.projectIdentifier', 'Lific project identifier'),
  projectIdentifierPlaceholder: (): string =>
    translate('settings.lific.profile.projectIdentifierPlaceholder', 'APP'),
  clientConfigScope: (): string =>
    translate('settings.lific.profile.clientConfigScope', 'Client config scope'),
  globalRecommended: (): string =>
    translate('settings.lific.profile.globalRecommended', 'Global (recommended)'),
  project: (): string => translate('settings.lific.profile.project', 'Project'),

  save: (): string => translate('settings.lific.actions.save', 'Save'),
  preview: (): string => translate('settings.lific.actions.preview', 'Preview'),
  connect: (): string => translate('settings.lific.actions.connect', 'Connect'),
  reconnect: (): string => translate('settings.lific.actions.reconnect', 'Reconnect / rotate'),
  disconnect: (): string => translate('settings.lific.actions.disconnect', 'Disconnect'),
  updateAgentsMd: (): string =>
    translate('settings.lific.actions.updateAgentsMd', 'Update AGENTS.md'),

  operationFailed: (): string =>
    translate('settings.lific.errors.operationFailed', 'Lific operation failed'),
  sshDestinationRequired: (): string =>
    translate('settings.lific.errors.sshDestinationRequired', 'SSH destination is required'),
  sshPortInvalid: (): string =>
    translate(
      'settings.lific.errors.sshPortInvalid',
      'SSH port must be an integer from 1 to 65535'
    ),
  wslDistributionRequired: (): string =>
    translate('settings.lific.errors.wslDistributionRequired', 'WSL distribution is required'),
  serverUrlsRequired: (): string =>
    translate(
      'settings.lific.errors.serverUrlsRequired',
      'Lific server URL and MCP URL are required'
    ),
  databasePathRequired: (): string =>
    translate('settings.lific.errors.databasePathRequired', 'Lific database path is required'),
  saveBeforePreview: (): string =>
    translate(
      'settings.lific.errors.saveBeforePreview',
      'Save the Lific profile before previewing client changes'
    ),

  mcpConnected: (): string =>
    translate('settings.lific.toasts.mcpConnected', 'Lific MCP connected'),
  cliFallbackEnabled: (): string =>
    translate('settings.lific.toasts.cliFallbackEnabled', 'Lific CLI fallback enabled'),
  reconnected: (): string =>
    translate(
      'settings.lific.toasts.reconnected',
      'Lific harness reconnected with a replacement credential'
    ),
  disconnected: (): string =>
    translate('settings.lific.toasts.disconnected', 'Lific harness disconnected'),
  agentsMdUpdated: (): string =>
    translate('settings.lific.toasts.agentsMdUpdated', 'AGENTS.md updated'),

  statusNotChecked: (): string => translate('settings.lific.status.notChecked', 'Not checked'),
  statusReady: (time: string): string =>
    translate('settings.lific.status.ready', 'Ready · checked {{time}}', { time }),
  statusNotInstalled: (): string =>
    translate(
      'settings.lific.status.notInstalled',
      'Lific is not installed on this execution host'
    ),
  statusNotInitialized: (): string =>
    translate(
      'settings.lific.status.notInitialized',
      'Lific is installed but no instance is initialized'
    ),
  statusNotConfigured: (): string =>
    translate('settings.lific.status.notConfigured', 'The selected harness is not configured'),
  statusUnsupportedAgent: (agent: string): string =>
    translate(
      'settings.lific.status.unsupportedAgent',
      'No native MCP mapping for {{agent}}; CLI fallback will be used',
      { agent }
    ),

  taskConsoleTitle: (): string => translate('settings.lific.tasks.title', 'Lific Task Console'),
  taskConsoleDescription: (): string =>
    translate(
      'settings.lific.tasks.description',
      'Native projects, issues, plans, pages, comments and search through Orca runtime RPC.'
    ),
  refreshProjects: (): string =>
    translate('settings.lific.tasks.refreshProjects', 'Refresh Lific projects'),
  saveAndConnect: (): string =>
    translate(
      'settings.lific.tasks.saveAndConnect',
      'Save and connect a profile to use native Lific Tasks.'
    ),
  noProjects: (): string => translate('settings.lific.tasks.noProjects', 'No projects loaded'),
  searchLabel: (): string =>
    translate('settings.lific.tasks.searchLabel', 'Search issues and pages'),
  searchPlaceholder: (): string =>
    translate('settings.lific.tasks.searchPlaceholder', 'authentication, APP-42, design notes…'),
  search: (): string => translate('settings.lific.tasks.search', 'Search'),
  searchResults: (count: number): string =>
    translate('settings.lific.tasks.searchResults', 'Search results ({{count}})', { count }),
  issues: (count: number): string =>
    translate('settings.lific.tasks.issues', 'Issues ({{count}})', { count }),
  noMatchingIssues: (): string =>
    translate('settings.lific.tasks.noMatchingIssues', 'No matching issues.'),
  status: (): string => translate('settings.lific.tasks.status', 'Status'),
  statusPlaceholder: (): string =>
    translate('settings.lific.tasks.statusPlaceholder', 'started, done…'),
  update: (): string => translate('settings.lific.tasks.update', 'Update'),
  comments: (count: number): string =>
    translate('settings.lific.tasks.comments', 'Comments ({{count}})', { count }),
  commentPlaceholder: (): string =>
    translate(
      'settings.lific.tasks.commentPlaceholder',
      'Add a verified progress or completion note'
    ),
  comment: (): string => translate('settings.lific.tasks.comment', 'Comment'),
  selectIssue: (): string =>
    translate(
      'settings.lific.tasks.selectIssue',
      'Select an issue to read it, change status and add comments.'
    ),
  plans: (count: number): string =>
    translate('settings.lific.tasks.plans', 'Plans ({{count}})', { count }),
  noPlans: (): string => translate('settings.lific.tasks.noPlans', 'No plans.'),
  topLevelSteps: (count: number): string =>
    translate('settings.lific.tasks.topLevelSteps', '{{count}} top-level steps', { count }),
  pages: (count: number): string =>
    translate('settings.lific.tasks.pages', 'Pages ({{count}})', { count }),
  noPages: (): string => translate('settings.lific.tasks.noPages', 'No pages.'),
  priority: (priority: string): string =>
    translate('settings.lific.tasks.priority', 'priority {{priority}}', { priority }),

  searchEntryDescription: (): string =>
    translate(
      'settings.lific.search.description',
      'Configure host-aware Lific MCP, issue context, plans, and Tasks.'
    ),
  searchKeywordLific: (): string => translate('settings.lific.search.keywordLific', 'lific'),
  searchKeywordMcp: (): string => translate('settings.lific.search.keywordMcp', 'mcp'),
  searchKeywordIssues: (): string => translate('settings.lific.search.keywordIssues', 'issues'),
  searchKeywordPlans: (): string => translate('settings.lific.search.keywordPlans', 'plans'),
  searchKeywordTasks: (): string => translate('settings.lific.search.keywordTasks', 'tasks'),
  searchKeywordAgentMemory: (): string =>
    translate('settings.lific.search.keywordAgentMemory', 'agent memory')
}
