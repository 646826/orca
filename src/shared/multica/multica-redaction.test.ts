import { describe, expect, it } from 'vitest'
import { redactMulticaSecrets } from './multica-redaction'

const PAT = 'mul_abcdefghijklmnopqrstuvwxyz0123456789'
const TASK_TOKEN = 'mat_abcdefghijklmnopqrstuvwxyz0123456789'

describe('Multica secret redaction', () => {
  it('redacts PATs, task tokens, bearer headers, environment values, and URL userinfo', () => {
    const output = redactMulticaSecrets(
      [
        PAT,
        TASK_TOKEN,
        'Authorization: Bearer secret-value',
        'MULTICA_TOKEN=secret-value',
        'https://user:password@example.com/path'
      ].join('\n')
    )

    for (const secret of [
      PAT,
      TASK_TOKEN,
      'secret-value',
      'user:password',
      'password@example.com'
    ]) {
      expect(output).not.toContain(secret)
    }

    expect(output).toContain('[REDACTED_MULTICA_TOKEN]')
    expect(output).toContain('Authorization: Bearer [REDACTED]')
    expect(output).toContain('MULTICA_TOKEN=[REDACTED]')
    expect(output).toContain('https://[REDACTED]@example.com/path')
  })

  it('preserves non-secret diagnostic context', () => {
    expect(redactMulticaSecrets('GET https://api.example.com/health returned 503')).toBe(
      'GET https://api.example.com/health returned 503'
    )
  })
})
