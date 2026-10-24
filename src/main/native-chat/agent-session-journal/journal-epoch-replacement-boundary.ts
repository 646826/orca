/** Structural validation only. The writer binds this boundary to the actual retired epoch
 * inside its publication transaction; legacy absence carries no replacement authority. */
export function hasValidJournalReplacementBoundary(value: unknown, currentEpoch: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return (
    'epoch' in value &&
    'endSequence' in value &&
    typeof value.epoch === 'string' &&
    value.epoch.length > 0 &&
    value.epoch !== currentEpoch &&
    typeof value.endSequence === 'number' &&
    Number.isSafeInteger(value.endSequence) &&
    value.endSequence > 0
  )
}
