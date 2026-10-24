export const forwardCompatibleBodies = [
  { kind: 'future-body', payload: { version: 7, nested: ['retained', { enabled: true }] } },
  {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'future-block', payload: { bytes: [1, 2, 3], label: 'preserved' } }]
  },
  {
    kind: 'message',
    role: 'assistant',
    futureMessageField: { retained: 'message extension' },
    blocks: [{ type: 'text', text: 'known body', futureTextField: { retained: 'block extension' } }]
  }
]
