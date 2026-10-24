import { redactString } from '../../observability/redactor'

/** Known-pattern guard only; the recipient disclosure decision remains mandatory. */
export async function* checkConversationPreparationText(chunks: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let tail = ''
  const inspect = (text: string) => {
    const window = tail + text
    if (redactString(window) !== window || /-----BEGIN [A-Z ]+-----/.test(window)) {
      throw new Error('known-sensitive-source')
    }
    tail = window.slice(-65536)
  }
  for await (const chunk of chunks) {
    inspect(decoder.decode(chunk, { stream: true }))
    yield chunk
  }
  inspect(decoder.decode())
}
