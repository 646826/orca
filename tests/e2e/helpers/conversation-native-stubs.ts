import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path'
import { z } from 'zod'
import { test as base } from './structured-claude-stub'
import { resolveCliCommand } from '../../../src/shared/node-cli-command-resolution'

export const SUPPORTED = process.platform === 'linux'
export type ConversationFixtureAgent = 'claude' | 'codex' | 'opencode'
const Input = z.object({
  kind: z.literal('input'),
  nativeId: z.string(),
  input: z.unknown(),
  clientId: z.string().optional()
})
export type ConversationNativeStubs = {
  commands: Record<ConversationFixtureAgent, string>
  directory: string
  inputs(agent: ConversationFixtureAgent): z.infer<typeof Input>[]
  holdAcceptance(agent: ConversationFixtureAgent): void
  releaseAcceptance(agent: ConversationFixtureAgent): void
}
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
export const test = base.extend<{ conversationStubs: ConversationNativeStubs }>({
  conversationStubs: async ({ claudeStub }, provideFixture, testInfo) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-e2e-conversation-'))
    const commands = {
      claude: claudeStub.command,
      codex: join(directory, 'codex'),
      opencode: join(directory, 'opencode')
    }
    for (const agent of ['codex', 'opencode'] as const) {
      const resolved = resolveCliCommand(agent, {
        pathEnv: systemPath.join(delimiter),
        homePath: directory
      })
      if (isAbsolute(resolved)) {
        rmSync(directory, { recursive: true, force: true })
        testInfo.skip(true, `system ${agent} could shadow fixture`)
      }
      writeFileSync(
        commands[agent],
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('tests/e2e/fixtures/conversation-native-stub.cjs'))} ${quote(agent)} ${quote(directory)} "$@"\n`
      )
      chmodSync(commands[agent], 0o755)
    }
    await provideFixture({
      commands,
      directory,
      inputs(agent) {
        const file = join(directory, `${agent}.jsonl`)
        return existsSync(file)
          ? readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .flatMap((line) => {
                const result = Input.safeParse(JSON.parse(line))
                return result.success ? [result.data] : []
              })
          : []
      },
      holdAcceptance(agent) {
        writeFileSync(join(directory, `${agent}.hold`), '')
      },
      releaseAcceptance(agent) {
        rmSync(join(directory, `${agent}.hold`), { force: true })
      }
    })
    rmSync(directory, { recursive: true, force: true })
  },
  launchEnv: async ({ conversationStubs }, provideFixture) => {
    await provideFixture({
      PATH: [
        dirname(conversationStubs.commands.claude),
        conversationStubs.directory,
        ...systemPath
      ].join(delimiter),
      ORCA_E2E_CONVERSATION_STUB_DIRECTORY: conversationStubs.directory,
      ORCA_BACKGROUND_LAUNCH: '1'
    })
  }
})
