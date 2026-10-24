import type { JournalOperationReceipt } from './journal-row-writer'
import { assertJournalSynchronousResult } from './journal-write-queue'

/** Invalidate every participant; poisoning must not replace the original rolled-back failure. */
export function rollbackJournalEpochReceipts(
  receipts: readonly (JournalOperationReceipt | undefined)[],
  failed?: (error: unknown) => void
): void {
  for (const receipt of receipts) {
    try {
      assertJournalSynchronousResult(receipt?.rolledBack?.())
    } catch (error) {
      try {
        assertJournalSynchronousResult(failed?.(error))
      } catch (poisonError) {
        console.warn('[journal-epoch] rollback invalidation failed', poisonError)
      }
    }
  }
}
