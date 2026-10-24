import type Database from '../../sqlite/sync-database'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { createAgentSessionUploadOwnership } from './agent-session-upload-provenance'

export async function seedUploadTestSessions(stateDirectory: string, sessionIds: string[]) {
  await seedTestAgentSessionRecordStore(stateDirectory, {
    records: sessionIds.map((sessionId) =>
      foundAgentSessionRecord(
        {
          sessionId,
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/test/account' },
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'upload-test',
            workspaceKind: 'folder'
          }
        },
        { claimKeyId: sessionId, now: 1 }
      )
    )
  })
}
/** Fixture wrote these exact bytes; exercise the same captured-owner commit as upload ingress. */
export function commitTestUploadOwner(
  db: Database.Database,
  input: {
    sessionId: string
    uploadId: string
    name: string
    byteLength: number
  }
) {
  const ownership = createAgentSessionUploadOwnership(() => db)
  const owner = ownership.capture(input.sessionId)
  ownership.begin({ ...input, owner })
  ownership.commit(input.uploadId, owner)
}
