import { boundedLifecycleProjection } from './conversation-context-bounded-row'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import parser, { type Token } from 'stream-json/core/parser.js'
import exec from 'stream-chain/exec.js'
import { none } from 'stream-chain/defs.js'
import { parseJournalRow, type JournalRow } from '../agent-session-journal/journal-row-schema'
import { ConversationExportError } from './conversation-artifact-disclosure'

type Container = { kind: 'object' | 'array'; path: string[]; count: number; key: string }
const SCALAR_LIMIT = 64 * 1024
const PROJECTION_LIMIT = 1024 * 1024
/** These exact leaves use z.string() only; the projection is validation evidence, never history. */
function freeFormString(path: string[]): boolean {
  return (
    (path.length === 3 &&
      path[0] === 'body' &&
      (path[1] === 'output' || path[1] === 'patch') &&
      path[2] === 'head') ||
    (path.length === 5 &&
      path[0] === 'change' &&
      path[1] === 'body' &&
      path[2] === 'blocks' &&
      /^\d+$/.test(path[3] ?? '') &&
      (path[4] === 'text' || path[4] === 'output')) ||
    (path.length === 4 &&
      path[0] === 'body' &&
      path[1] === 'blocks' &&
      /^\d+$/.test(path[2] ?? '') &&
      (path[3] === 'text' || path[3] === 'output'))
  )
}
function createRowProjection(toolReference?: string): {
  write: (text: string) => void
  end: () => { row: JournalRow; substitutedPaths: string[] }
} {
  const containers: Container[] = []
  const parts: string[] = []
  const substitutedPaths: string[] = []
  let projectionLength = 0,
    scalar = '',
    scalarKind: 'key' | 'string' | 'number' | null = null,
    substitute = false,
    allowed = false,
    finished = false
  const path = (): string[] => {
    const parent = containers.at(-1)
    return parent
      ? [...parent.path, parent.kind === 'array' ? String(parent.count) : parent.key]
      : []
  }
  const append = (text: string): void => {
    projectionLength += text.length
    if (projectionLength > PROJECTION_LIMIT || parts.length >= 32768) {
      throw new ConversationExportError('resource-limit')
    }
    parts.push(text)
  }
  const prefix = (): void => {
    const parent = containers.at(-1)
    if (!parent) {
      return
    }
    if (parent.count > 0) {
      append(',')
    }
    if (parent.kind === 'object') {
      append(`${JSON.stringify(parent.key)}:`)
    }
    parent.count++
  }
  const consume = (token: Token): void => {
    if (token.name === 'startObject' || token.name === 'startArray') {
      const nextPath = path()
      prefix()
      append(token.name === 'startObject' ? '{' : '[')
      if (containers.length >= 64) {
        throw new ConversationExportError('resource-limit')
      }
      containers.push({
        kind: token.name === 'startObject' ? 'object' : 'array',
        path: nextPath,
        count: 0,
        key: ''
      })
    } else if (token.name === 'endObject' || token.name === 'endArray') {
      containers.pop()
      append(token.name === 'endObject' ? '}' : ']')
    } else if (
      token.name === 'startKey' ||
      token.name === 'startString' ||
      token.name === 'startNumber'
    ) {
      scalarKind =
        token.name === 'startKey' ? 'key' : token.name === 'startString' ? 'string' : 'number'
      scalar = ''
      substitute = false
      allowed =
        scalarKind === 'string' &&
        freeFormString(path()) &&
        (toolReference === undefined ||
          path().at(-1) === 'output' ||
          path().join('/') === 'body/output/head')
    } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      if (!substitute) {
        scalar += token.value
        const limit =
          scalarKind === 'key'
            ? 4096
            : toolReference !== undefined && freeFormString(path()) && path().at(-1) === 'text'
              ? 256 * 1024
              : SCALAR_LIMIT
        if (scalar.length > limit) {
          if (!allowed) {
            throw new ConversationExportError('resource-limit')
          }
          substitute = true
          scalar = ''
        }
      }
    } else if (token.name === 'endKey') {
      const parent = containers.at(-1)
      if (!parent) {
        throw new ConversationExportError('corrupt-source')
      }
      parent.key = scalar
      scalarKind = null
    } else if (token.name === 'endString' || token.name === 'endNumber') {
      if (substitute) {
        substitutedPaths.push(path().join('/'))
      }
      prefix()
      append(
        token.name === 'endString'
          ? JSON.stringify(substitute ? (toolReference ?? '') : scalar)
          : scalar
      )
      scalarKind = null
    } else if (
      token.name === 'trueValue' ||
      token.name === 'falseValue' ||
      token.name === 'nullValue'
    ) {
      prefix()
      append(token.name === 'trueValue' ? 'true' : token.name === 'falseValue' ? 'false' : 'null')
    }
  }
  const parse = exec(
    parser({
      packKeys: false,
      packStrings: false,
      packNumbers: false,
      streamKeys: true,
      streamStrings: true,
      streamNumbers: true
    })
  )
  const run = (value: string | typeof none): void => {
    try {
      const pending = parse(value, consume)
      if (pending) {
        throw new ConversationExportError('corrupt-source')
      }
    } catch (error) {
      if (error instanceof ConversationExportError) {
        throw error
      }
      throw new ConversationExportError('corrupt-source')
    }
  }
  return {
    write(text) {
      if (finished) {
        throw new ConversationExportError('corrupt-source')
      }
      for (let offset = 0; offset < text.length; offset += 16 * 1024) {
        run(text.slice(offset, offset + 16 * 1024))
      }
    },
    end() {
      if (finished) {
        throw new ConversationExportError('corrupt-source')
      }
      finished = true
      run(none)
      const parsed = parseJournalRow(parts.join(''))
      if (!parsed.ok) {
        throw new ConversationExportError(parsed.unreadable ? 'newer-schema' : 'corrupt-source')
      }
      if (
        parsed.row.kind !== 'item' &&
        parsed.row.kind !== 'queue' &&
        substitutedPaths.length > 0
      ) {
        throw new ConversationExportError('resource-limit')
      }
      return { row: parsed.row, substitutedPaths }
    }
  }
}

function hasCapturedGap(body: AgentJournalItemBody): boolean {
  return (
    (body.kind === 'tool-call' && body.output?.truncated === true) ||
    (body.kind === 'diff' && body.patch.truncated === true)
  )
}

export function createConversationContextRowValidator(input: { byteLength?: number } = {}) {
  const projection = boundedLifecycleProjection(input.byteLength, () => createRowProjection())
  return {
    write: projection.write,
    end() {
      const { row, substitutedPaths } = projection.end()
      return {
        envelope: {
          epoch: row.epoch,
          sequence: row.seq,
          kind: row.kind,
          ...(row.kind === 'item' ? { itemId: row.itemId, itemRevision: row.revision } : {})
        },
        substitutedPaths,
        mutationCount: row.kind === 'lifecycle-batch' ? row.mutations.length : 0,
        capturedIncomplete:
          row.kind === 'item'
            ? hasCapturedGap(row.body)
            : row.kind === 'lifecycle-batch' &&
              row.mutations.some(
                (mutation) => mutation.kind === 'item' && hasCapturedGap(mutation.body)
              )
      }
    }
  }
}
export function createConversationToolEvidenceProjection(input: {
  referenceText: string
  byteLength?: number
}) {
  if (input.referenceText.length === 0 || input.referenceText.length > 4096) {
    throw new ConversationExportError('resource-limit')
  }
  const projection = boundedLifecycleProjection(input.byteLength, () =>
    createRowProjection(input.referenceText)
  )
  return {
    write: projection.write,
    end() {
      const { row, substitutedPaths } = projection.end()
      return {
        representation: 'source-backed-tool-projection' as const,
        projectedRow: row,
        substitutedPaths
      }
    }
  }
}
