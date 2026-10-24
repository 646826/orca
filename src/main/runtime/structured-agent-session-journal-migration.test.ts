import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalDatabase as openVersion4Database } from '../native-chat/agent-session-journal/journal-database-v4.fixture'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import { acquireProfileStateRuntimeAdmission } from '../persistence/profile-state/profile-state-access'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { openStructuredAgentSessionJournalDatabase } from './structured-agent-session-journal-open'

const roots: string[] = []
function fixture() {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-host-journal-migration-'))
  roots.push(stateDirectory)
  const path = journalDatabasePath(stateDirectory)
  openVersion4Database(path).db.close()
  const logger = recordingStructuredAgentSessionLogger().logger
  return {
    stateDirectory,
    path,
    open: () => openStructuredAgentSessionJournalDatabase({ stateDirectory, logger })
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('host journal migration ownership', () => {
  it('leaves schema-4 bytes unchanged without an admitted runtime', () => {
    const f = fixture()
    const before = readFileSync(f.path)
    expect(f.open).toThrow()
    expect(readFileSync(f.path)).toEqual(before)
  })

  it('refuses migration while another same-process runtime admission exists', () => {
    const f = fixture()
    const first = acquireProfileStateRuntimeAdmission(f.stateDirectory)
    const second = acquireProfileStateRuntimeAdmission(f.stateDirectory)
    const before = readFileSync(f.path)
    try {
      expect(f.open).toThrow()
      expect(readFileSync(f.path)).toEqual(before)
      second.release()
      const opened = f.open()
      try {
        expect(opened.db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
      } finally {
        opened.close()
      }
    } finally {
      second.release()
      first.release()
    }
  })
})
