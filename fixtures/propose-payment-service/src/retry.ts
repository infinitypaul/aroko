export type RetryRecord = {
  reference: string;
  customerId?: string | null;
};

/**
 * Intentionally buggy: drops the original payment reference and synthesizes
 * one from customerId. Used by Stage 15 Prompt 3 change.propose proofs.
 */
export function rebuildPaymentFromRetryRecord(retryRecord: RetryRecord) {
  return {
    reference: `retry:${retryRecord.customerId ?? "unknown"}`,
    customerId: retryRecord.customerId ?? null
  };
}
