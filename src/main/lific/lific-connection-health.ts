import { buildLificHealthInvocation } from './lific-commands'
import { redactLificSecrets } from '../../shared/lific/lific-redaction'
import type {
  LificCommandRunner,
  LificConnectionProfile,
  LificHealthState
} from '../../shared/lific/lific-types'

function parseVersion(text: string): [number, number, number] | null {
  const match = text.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function versionAtLeast(
  actual: [number, number, number],
  minimum: [number, number, number]
): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = actual[index] ?? 0
    const right = minimum[index] ?? 0
    if (left > right) {
      return true
    }
    if (left < right) {
      return false
    }
  }
  return true
}

export async function probeLificHealth(input: {
  profile: LificConnectionProfile
  executable: string
  credential?: string
  runner: LificCommandRunner
  minimumVersion?: string
  now?: () => number
}): Promise<LificHealthState> {
  const version = await input.runner.run({
    command: input.executable,
    args: ['--version'],
    shell: false
  })
  if (version.errorCode === 'ENOENT') {
    return { kind: 'not-installed' }
  }
  if (version.exitCode !== 0) {
    return {
      kind: 'unreachable',
      message: redactLificSecrets(version.stderr || 'Unable to execute Lific')
    }
  }

  const minimumText = input.minimumVersion ?? '2.5.0'
  const actual = parseVersion(version.stdout || version.stderr)
  const minimum = parseVersion(minimumText)
  if (!actual || !minimum || !versionAtLeast(actual, minimum)) {
    return {
      kind: 'unsupported-version',
      message: `Lific ${minimumText} or newer is required.`
    }
  }

  const credential = input.credential?.trim()
  if (input.profile.transport.kind === 'http') {
    const capability = await input.runner.run({
      command: input.executable,
      args: ['connect', '--help'],
      shell: false
    })
    const help = `${capability.stdout}
${capability.stderr}`
    if (
      capability.exitCode !== 0 ||
      !help.includes('--config-only') ||
      !help.includes('--key-env')
    ) {
      return {
        kind: 'unsupported-version',
        message:
          'This Lific binary lacks the remote config-only contract (--config-only and --key-env). Apply the bundled Lific patch or install a compatible release.'
      }
    }
    if (!credential) {
      return { kind: 'not-configured' }
    }
  }

  const probe = await input.runner.run(
    buildLificHealthInvocation({
      executable: input.executable,
      transport: input.profile.transport,
      ...(credential ? { credential } : {})
    })
  )
  if (probe.exitCode !== 0) {
    const fallback =
      input.profile.transport.kind === 'http'
        ? 'Lific HTTP backend probe failed'
        : 'Lific doctor failed'
    const message = redactLificSecrets(probe.stderr || probe.stdout || fallback)
    if (/auth|unauthorized|forbidden|401|403/i.test(message)) {
      return { kind: 'authentication-failed', message }
    }
    if (/database|instance|initialize/i.test(message)) {
      return { kind: 'not-initialized' }
    }
    return { kind: 'unreachable', message }
  }
  return { kind: 'ready', checkedAt: (input.now ?? Date.now)() }
}
