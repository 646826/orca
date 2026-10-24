import { expect, it } from 'vitest'
import {
  nativeConversationCapabilities,
  nativeConversationReportedOptions
} from './conversation-native-capabilities'

const live = {
  agent: 'codex',
  protocol: 'codex-app-server-v2',
  version: '0.159.0-alpha.3',
  nativeSessionId: 'thread',
  acquisitionGeneration: 'acquired',
  fence: 1,
  launch: { command: '/native/codex', cwd: '/workspace', permission: 'ask' },
  options: { model: 'chosen' },
  initialized: true,
  closed: false,
  resume: true
}
it('requires initialized live native identity and an explicit supported protocol contract', () => {
  expect(nativeConversationCapabilities(null)).toEqual({ state: 'unverified' })
  expect(nativeConversationCapabilities({ ...live, initialized: false })).toEqual({
    state: 'unverified'
  })
  expect(nativeConversationCapabilities({ ...live, closed: true })).toEqual({ state: 'unverified' })
  expect(nativeConversationCapabilities({ ...live, nativeSessionId: '' })).toEqual({
    state: 'unverified'
  })
  expect(nativeConversationCapabilities({ ...live, protocol: 'future' })).toEqual({
    state: 'unverified'
  })
})
it('reports only the limited protocol contract and invalidates old fingerprints on scope changes', () => {
  const capability = nativeConversationCapabilities(live)
  expect(capability).toMatchObject({
    state: 'verified',
    firstTurnReceipt: 'live-acceptance',
    passiveImport: 'unsupported',
    nonMutatingHydration: 'unsupported',
    startupTrust: 'unverified',
    artifactAccess: ['text'],
    budget: 'unknown'
  })
  if (capability.state !== 'verified') {
    throw new Error('missing capability')
  }
  for (const changed of [
    { ...live, acquisitionGeneration: 'replacement' },
    { ...live, nativeSessionId: 'other' },
    { ...live, options: { model: 'other' } },
    { ...live, launch: { ...live.launch, permission: 'deny' } }
  ]) {
    const next = nativeConversationCapabilities(changed)
    expect(next.state === 'verified' && next.runtimeFingerprint).not.toBe(
      capability.runtimeFingerprint
    )
  }
})

it('keeps first default telemetry stable but invalidates a known model change', () => {
  const observation = { ...live, options: {} }
  const read = (reported: Record<string, string>) =>
    nativeConversationCapabilities({
      ...observation,
      options: nativeConversationReportedOptions(observation, reported)
    })
  const initial = read({})
  expect(read({ model: 'default-model' })).toEqual(initial)
  const changed = read({ model: 'different-model' })
  expect(changed).not.toEqual(initial)
  expect(read({ model: 'default-model' })).not.toEqual(initial)
})
