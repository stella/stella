import { dbClock } from "@stll/test-kit/db";

const CLAIM_DEADLINE_MS = 60_000;

/** A run's claim on a pending cell, written as the claim writes one: run, batch, deadline and attempt together. */
export const pendingCellClaim = (ownerRunId: string, attempt: 0 | 1 = 0) => ({
  ownerRunId,
  ownerBatchId: "batch-1",
  deadlineAt: dbClock.fromNow(CLAIM_DEADLINE_MS),
  attempt,
});

/** No claim: what every non-pending cell, and an unowned pending one, carries. */
export const NO_CELL_CLAIM = {
  ownerRunId: null,
  ownerBatchId: null,
  deadlineAt: null,
  attempt: null,
} as const;
