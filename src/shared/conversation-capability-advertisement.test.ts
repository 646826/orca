import { expect, test } from 'vitest'
import { RUNTIME_CAPABILITIES } from './protocol-version'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../main/ipc/desktop-renderer-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from './electron-remote-runtime-client-capabilities'

test('host and full desktop consumers advertise aggregate support', () => {
  for (const capabilities of [
    RUNTIME_CAPABILITIES,
    DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  ]) {
    expect(capabilities).toContain('agent-session.conversations.v2')
    expect(capabilities).not.toContain('agent-session.conversations.v1')
  }
})
test('host explicitly advertises read-only aggregate support', () => {
  expect(RUNTIME_CAPABILITIES).toContain('agent-session.conversations.read.v1')
})
