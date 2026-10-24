import { expect, test } from 'vitest'
import { conversationPreparationModel } from './structured-conversation-preparation-factory'

test('explicit selected model requires matching projected model, and refuses absent selection before transfer effects', () => {
  expect(conversationPreparationModel('selected', undefined)).toBeNull()
  expect(conversationPreparationModel('selected', {})).toBeNull()
  expect(conversationPreparationModel('selected', { model: 'different' })).toBeNull()
  expect(conversationPreparationModel('selected', { model: 'selected' })).toBe('selected')
  expect(conversationPreparationModel(undefined, undefined)).toBeNull()
  expect(conversationPreparationModel('default', { model: 'default' })).toBeNull()
  expect(
    conversationPreparationModel('provider-default (unreported)', {
      model: 'provider-default (unreported)'
    })
  ).toBeNull()
})
