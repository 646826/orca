import { readFileSync } from 'node:fs'
import { getRequiredStringFlag } from '../flags'

export type LificCliFlags = Parameters<typeof getRequiredStringFlag>[0]

export const formatLificResult = (value: unknown): string => JSON.stringify(value, null, 2)

export function requireLificStdin(flags: LificCliFlags): string {
  if (flags.get('stdin') !== true) {
    throw new Error('Pass --stdin so the secret is not placed in argv')
  }
  const value = readFileSync(0, 'utf8').trim()
  if (!value) {
    throw new Error('stdin was empty')
  }
  return value
}

export function positiveLificNumber(flags: LificCliFlags, name: string): number {
  const raw = getRequiredStringFlag(flags, name)
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}
