import { and, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type { REPLAY_BATCH_STATUSES } from "@/api/db/schema";
import { caseLawReplayBatches } from "@/api/db/schema";

export const REPLAY_PENDING_RECEIPT_STATUSES = [
  "reserved",
  "retry-exhausted",
] as const satisfies readonly (typeof REPLAY_BATCH_STATUSES)[number][];

/** Recovery and priority use the same due boundary, including durable backoff. */
export const dueCaseLawReplayPendingReceipt = (now: Date) =>
  and(
    inArray(caseLawReplayBatches.status, REPLAY_PENDING_RECEIPT_STATUSES),
    or(
      isNull(caseLawReplayBatches.retryAt),
      lte(caseLawReplayBatches.retryAt, sql`${now}::timestamptz`),
    ),
  );
