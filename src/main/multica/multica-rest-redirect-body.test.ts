import { describe, expect, it, vi } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import {
  MulticaRestClient,
  type MulticaFetch
} from './multica-rest-client'

const profile: MulticaConnectionProfile = {
  id: 'multica-cloud',
  displayName: 'Multica Cloud',
  executionHostId: 'local',
  dataPlane: {
    kind: 'rest',
    serverUrl: 'https://api.multica.example/',
    credentialRef: 'multica-cloud-token'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false
}

describe('Multica REST redirect body handling', () => {
  it('cancels an unread redirect body before following it', async () => {
    let cancelled = false
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const fetch = vi
      .fn<MulticaFetch>()
      .mockResolvedValueOnce(
        new Response(redirectBody, {
          status: 307,
          headers: { Location: '/api/v2/me' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'user-1' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    const client = new MulticaRestClient({
      profile,
      token: 'mul_redirect_test_secret_12345678',
      fetch,
      clientVersion: 'test-version',
      retryDelaysMs: []
    })

    await expect(client.getJson('/api/me')).resolves.toEqual({ id: 'user-1' })
    expect(cancelled).toBe(true)
  })
})
