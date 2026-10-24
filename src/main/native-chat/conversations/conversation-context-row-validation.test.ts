import { expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { parseJournalRow } from '../agent-session-journal/journal-row-schema'
import {
  createConversationToolEvidenceProjection,
  createConversationContextRowValidator
} from './conversation-context-row-validation'
const row = (body: unknown) => ({
  v: 3,
  epoch: 'epoch',
  seq: 2,
  fence: 1,
  ts: 2,
  kind: 'item',
  itemId: 'tool',
  revision: 1,
  body
})
function validate(value: unknown) {
  const validator = createConversationContextRowValidator()
  validator.write(JSON.stringify(value))
  return validator.end()
}
it('validates a large free-form payload without retaining its text in the validation projection', () => {
  const validator = createConversationContextRowValidator()
  validator.write(
    '{"v":3,"epoch":"epoch","seq":2,"fence":1,"ts":2,"kind":"item","itemId":"tool","revision":1,"body":{"kind":"tool-call","name":"shell","state":"completed","output":{"head":"'
  )
  for (let i = 0; i < 1024; i++) {
    validator.write('甲🙂'.repeat(1024))
  }
  validator.write('","byteLength":7340032,"digest":"original","truncated":false}}}')
  const result = validator.end()
  expect(result.substitutedPaths).toEqual(['body/output/head'])
  expect(result.envelope).toMatchObject({ epoch: 'epoch', sequence: 2, kind: 'item' })
})
it('does not substitute constrained state, IDs or plan text and preserves parser failures', () => {
  expect(() =>
    validate(
      row({
        kind: 'tool-call',
        name: 'shell',
        state: '',
        callId: ' ',
        output: { head: 'large', byteLength: 5, digest: 'd', truncated: false }
      })
    )
  ).toThrow()

  expect(() =>
    validate({ ...row({ kind: 'tool-call', name: 'shell', state: 'done' }), v: 999 })
  ).toThrow('newer-schema')
  expect(() =>
    validate({
      ...row({ kind: 'tool-call', name: 'shell', state: 'done' }),
      itemId: 'x'.repeat(100000)
    })
  ).toThrow('resource-limit')
})
it('preserves duplicate-key last-value semantics and refuses malformed JSON', () => {
  const validator = createConversationContextRowValidator()
  validator.write(
    JSON.stringify(row({ kind: 'tool-call', name: 'shell', state: 'done' })).replace(
      '"state":"done"',
      '"state":"done","state":""'
    )
  )
  expect(() => validator.end()).toThrow('corrupt-source')
  const broken = createConversationContextRowValidator()
  expect(() => {
    broken.write('{"v":3,')
    broken.end()
  }).toThrow()
})
it('never substitutes nested lifecycle metadata or arbitrary unknown structures', () => {
  expect(() =>
    validate({
      ...row({ kind: 'tool-call', name: 'shell', state: 'done' }),
      arbitrary: { head: 'x'.repeat(100000) }
    })
  ).toThrow('resource-limit')
  expect(() =>
    validate(
      row({
        kind: 'tool-call',
        name: 'shell',
        state: 'done',
        output: { head: 17, byteLength: 1, digest: 'd', truncated: false }
      })
    )
  ).toThrow('corrupt-source')
})

it('matches canonical verdicts for reordered unions, duplicate discriminants and nested mutations', () => {
  const valid = row({
    output: { head: 'x'.repeat(70000), byteLength: 70000, digest: 'd', truncated: false },
    state: 'done',
    name: 'shell',
    kind: 'tool-call'
  })
  const cases = [
    JSON.stringify(valid),
    JSON.stringify(valid).replace('"v":3', '"v":999,"v":3'),
    JSON.stringify(valid).replace('"v":3', '"v":3,"v":999'),
    JSON.stringify({ ...valid, kind: 'future-kind' }),
    JSON.stringify({
      ...valid,
      kind: 'lifecycle-batch',
      settlementId: 'settle',
      body: undefined,
      mutations: [{ kind: 'future-mutation', itemId: 'x', revision: 1 }]
    }),
    JSON.stringify({
      ...valid,
      kind: 'lifecycle-batch',
      settlementId: 'settle',
      body: undefined,
      mutations: [
        {
          kind: 'item',
          itemId: 'x',
          revision: 1,
          body: { kind: 'tool-call', name: 's', state: '' }
        }
      ]
    })
  ]
  for (const text of cases) {
    const expected = parseJournalRow(text)
    const validator = createConversationContextRowValidator()
    if (expected.ok) {
      validator.write(text)
      expect(validator.end().envelope.kind).toBe(expected.row.kind)
    } else {
      expect(() => {
        validator.write(text)
        validator.end()
      }).toThrow(expected.unreadable ? 'newer-schema' : 'corrupt-source')
    }
  }
})
it('keeps tool projections explicit and never replaces mandatory user text', () => {
  const projection = createConversationToolEvidenceProjection({
    referenceText: '[Original tool output: artifact source-1]'
  })
  projection.write(
    JSON.stringify(
      row({
        kind: 'tool-call',
        name: 'shell',
        state: 'done',
        output: { head: 'x'.repeat(70000), byteLength: 70000, digest: 'd', truncated: false }
      })
    )
  )
  expect(projection.end()).toMatchObject({
    representation: 'source-backed-tool-projection',
    substitutedPaths: ['body/output/head'],
    projectedRow: { body: { output: { head: '[Original tool output: artifact source-1]' } } }
  })
  const user = createConversationToolEvidenceProjection({ referenceText: 'artifact' })
  expect(() =>
    user.write(
      JSON.stringify(
        row({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(300000) }] })
      )
    )
  ).toThrow('resource-limit')
})
it('preserves prototype-named JSON keys without mutating prototypes and bounds structural metadata', () => {
  const text = JSON.stringify(row({ kind: 'tool-call', name: 'shell', state: 'done' })).replace(
    '"v":3',
    '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"v":3'
  )
  const validator = createConversationContextRowValidator()
  validator.write(text)
  expect(validator.end().envelope.kind).toBe('item')
  expect(Object.prototype).not.toHaveProperty('polluted')
  const deep = createConversationContextRowValidator()
  expect(() => deep.write(`{"v":${'['.repeat(70)}`)).toThrow('resource-limit')
})
it('retains captured-incomplete facts inside bounded lifecycle mutations', () => {
  const batch = {
    v: 3,
    epoch: 'epoch',
    seq: 2,
    fence: 1,
    ts: 2,
    kind: 'lifecycle-batch',
    settlementId: 'settle',
    mutations: [
      {
        kind: 'item',
        itemId: 'tool',
        revision: 1,
        body: {
          kind: 'tool-call',
          name: 'shell',
          state: 'done',
          output: { head: 'preview', byteLength: 1000, digest: 'digest', truncated: true }
        }
      }
    ]
  }
  expect(validate(batch)).toMatchObject({ mutationCount: 1, capturedIncomplete: true })
  expect(() => validate({ ...batch, mutations: [] })).toThrow('corrupt-source')
})
it('uses exact bounded lifecycle parsing for large nested payloads without relaxing the batch schema', () => {
  const output = `${'x'.repeat(1200000)}🙂 final`
  const batch = {
    v: 3,
    epoch: 'epoch',
    seq: 2,
    fence: 1,
    ts: 2,
    kind: 'lifecycle-batch',
    settlementId: 's',
    mutations: [
      {
        kind: 'item',
        itemId: 'tool',
        revision: 1,
        body: {
          kind: 'tool-call',
          name: 'shell',
          state: 'done',
          output: {
            head: output,
            byteLength: Buffer.byteLength(output),
            digest: 'd',
            truncated: false
          }
        }
      }
    ]
  }
  const raw = JSON.stringify(batch)
  expect(parseJournalRow(raw).ok).toBe(true)
  const validator = createConversationContextRowValidator({ byteLength: Buffer.byteLength(raw) })
  validator.write(raw)
  expect(validator.end()).toMatchObject({ mutationCount: 1, substitutedPaths: [] })
  const projection = createConversationToolEvidenceProjection({
    referenceText: 'artifact',
    byteLength: Buffer.byteLength(raw)
  })
  projection.write(raw)
  expect(projection.end().projectedRow).toEqual({
    ...batch,
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION
  })
  const newer = raw.replace('"v":3', '"v":9')
  const future = createConversationContextRowValidator({ byteLength: Buffer.byteLength(newer) })
  future.write(newer)
  expect(() => future.end()).toThrow('newer-schema')
  const short = createConversationContextRowValidator({ byteLength: 100 })
  expect(() => short.write(raw)).toThrow('resource-limit')
  const invalid = JSON.stringify({ ...batch, mutations: [...batch.mutations, ...batch.mutations] })
  const oversized = createConversationContextRowValidator({
    byteLength: Buffer.byteLength(invalid)
  })
  expect(() => {
    oversized.write(invalid)
    oversized.end()
  }).toThrow()
})
