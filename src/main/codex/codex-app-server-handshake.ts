import type { CodexAppServerConnection } from './codex-app-server-connection-types'

/** The caller owns the bound; null leaves cancellation to its startup signal. */
export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection,
  timeoutMs: number | null
): Promise<string | null> {
  const initialized = await connection.request(
    'initialize',
    {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        extensions: {}
      }
    },
    { timeoutMs }
  )
  connection.notify('initialized')
  if (
    typeof initialized !== 'object' ||
    initialized === null ||
    !('userAgent' in initialized) ||
    typeof initialized.userAgent !== 'string'
  ) {
    return null
  }
  return (
    /^codex_cli_rs\/([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)(?: |$)/.exec(
      initialized.userAgent
    )?.[1] ?? null
  )
}
