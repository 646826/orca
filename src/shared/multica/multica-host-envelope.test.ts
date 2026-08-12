import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  decodeMulticaHostEnvelope,
  encodeMulticaHostEnvelope,
  MULTICA_HOST_ENVELOPE_MAX_BYTES,
  type MulticaProcessInvocation
} from './multica-host-envelope'

const invocation: MulticaProcessInvocation = {
  command: 'multica',
  args: ['issue', 'list', '--output', 'json'],
  shell: false,
  cwd: '/workspace/repo',
  env: {
    MULTICA_TOKEN: 'mul_secret',
    MULTICA_SERVER_URL: 'https://api.multica.example',
    MULTICA_WORKSPACE_ID: 'workspace-id',
    MULTICA_PROFILE: 'production'
  },
  stdin: '{"query":"ready"}'
}

describe('Multica host execution envelope', () => {
  it('round-trips a validated process invocation', () => {
    expect(decodeMulticaHostEnvelope(encodeMulticaHostEnvelope(invocation))).toEqual(invocation)
  })

  it('rejects shell execution in both encode and decode paths', () => {
    expect(() =>
      encodeMulticaHostEnvelope({ ...invocation, shell: true } as unknown as MulticaProcessInvocation)
    ).toThrow('Multica process invocation requires shell=false')

    expect(() =>
      decodeMulticaHostEnvelope(
        encodeRawEnvelope({ ...invocation, shell: true })
      )
    ).toThrow('Multica process invocation requires shell=false')
  })

  it('rejects more than 128 arguments', () => {
    expect(() =>
      encodeMulticaHostEnvelope({
        ...invocation,
        args: Array.from({ length: 129 }, (_, index) => String(index))
      })
    ).toThrow('Multica process invocation supports at most 128 arguments')
  })

  it('accepts only the Multica environment allowlist', () => {
    expect(() =>
      encodeMulticaHostEnvelope({
        ...invocation,
        env: { ...invocation.env, PATH: '/tmp/bin' }
      })
    ).toThrow("Multica process environment key 'PATH' is not allowed")
  })

  it.each([
    ['command', { ...invocation, command: 'multica\0sh' }],
    ['argument', { ...invocation, args: ['issue', 'list\0--all'] }],
    ['cwd', { ...invocation, cwd: '/workspace\0elsewhere' }],
    ['stdin', { ...invocation, stdin: 'secret\0suffix' }],
    ['environment value', { ...invocation, env: { MULTICA_TOKEN: 'mul_secret\0suffix' } }]
  ])('rejects a NUL byte in %s', (_name, unsafeInvocation) => {
    expect(() => encodeMulticaHostEnvelope(unsafeInvocation as MulticaProcessInvocation)).toThrow(
      'Multica process invocation contains a NUL byte'
    )
  })

  it('rejects oversized encoded and decoded envelopes before execution', () => {
    expect(() =>
      encodeMulticaHostEnvelope({
        ...invocation,
        stdin: 'x'.repeat(MULTICA_HOST_ENVELOPE_MAX_BYTES)
      })
    ).toThrow('Multica host execution envelope exceeds')

    const oversized = encodeRawEnvelope({
      ...invocation,
      stdin: 'x'.repeat(MULTICA_HOST_ENVELOPE_MAX_BYTES)
    })
    expect(() => decodeMulticaHostEnvelope(oversized)).toThrow(
      'Multica host execution envelope exceeds'
    )
  })

  it('rejects malformed base64, unsupported schemas, and unknown invocation fields', () => {
    expect(() => decodeMulticaHostEnvelope('not-base64')).toThrow(
      'Invalid Orca Multica execution envelope'
    )
    expect(() =>
      decodeMulticaHostEnvelope(
        Buffer.from(JSON.stringify({ schemaVersion: 2, invocation }), 'utf8').toString('base64')
      )
    ).toThrow('Unsupported Orca Multica execution envelope')
    expect(() =>
      decodeMulticaHostEnvelope(encodeRawEnvelope({ ...invocation, extra: 'value' }))
    ).toThrow("Unknown Multica process invocation field 'extra'")
  })
})

function encodeRawEnvelope(rawInvocation: Record<string, unknown>): string {
  return Buffer.from(
    JSON.stringify({ schemaVersion: 1, invocation: rawInvocation }),
    'utf8'
  ).toString('base64')
}
