import { describe, expect, it } from 'vitest'
import type { MulticaConnectionProfile } from '../../shared/multica/multica-types'
import { buildMulticaCliInvocation } from './multica-cli-invocation'

const profile: MulticaConnectionProfile = {
  id: 'multica-cli',
  displayName: 'Multica CLI',
  executionHostId: 'local',
  dataPlane: {
    kind: 'cli',
    executable: 'multica',
    profileName: 'work',
    serverUrl: 'https://multica.example'
  },
  lifecycle: { kind: 'external' },
  managedByOrca: false
}

describe('Multica CLI version invocation', () => {
  it('requests JSON so the unified read transport can parse the result', () => {
    expect(buildMulticaCliInvocation(profile, { kind: 'version' })).toEqual({
      command: 'multica',
      args: [
        '--server-url',
        'https://multica.example',
        '--profile',
        'work',
        'version',
        '--output',
        'json'
      ],
      shell: false
    })
  })
})
