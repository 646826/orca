import { z } from 'zod'

export const ConversationWorkspaceObservationSchema = z.object({
  scopeDigest: z.string().min(1),
  watchIdentity: z.string().nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  continuity: z.enum(['observed', 'unknown'])
})
export type ConversationWorkspaceObservation = z.infer<
  typeof ConversationWorkspaceObservationSchema
>
export type ConversationWorkspaceObservationStatus =
  | 'observed-change'
  | 'no-change-observed'
  | 'unknown'

/** Event continuity is evidence of observation only, never exclusive workspace ownership. */
export function compareWorkspaceWatchObservation(
  captured: ConversationWorkspaceObservation,
  current: ConversationWorkspaceObservation
): ConversationWorkspaceObservationStatus {
  if (
    captured.scopeDigest !== current.scopeDigest ||
    captured.watchIdentity === null ||
    captured.watchIdentity !== current.watchIdentity ||
    captured.continuity !== 'observed' ||
    current.continuity !== 'observed' ||
    current.revision < captured.revision
  ) {
    return 'unknown'
  }
  return captured.revision === current.revision ? 'no-change-observed' : 'observed-change'
}
