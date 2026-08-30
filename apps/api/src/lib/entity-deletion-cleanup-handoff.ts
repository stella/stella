import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { withTimeout } from "@/api/lib/with-timeout";

const CLEANUP_HANDOFF_TIMEOUT_MS = 2000;
const CLEANUP_HANDOFF_TIMEOUT_LABEL = "entity-deletion-cleanup.handoff";
/** Requests accelerated inline; reconciliation claims any beyond this. */
const CLEANUP_HANDOFF_BATCH_MAX = 4;

type CleanupHandoffOptions = {
  captureDeliveryError: (
    error: unknown,
    context: { requestId: SafeId<"entityDeletionCleanupRequest"> },
  ) => void;
  enqueueCleanup: (
    requestId: SafeId<"entityDeletionCleanupRequest">,
  ) => Promise<void>;
  requestId: SafeId<"entityDeletionCleanupRequest">;
  timeoutMs?: number;
};

/**
 * Best-effort acceleration after the durable cleanup request commits.
 * Reconciliation owns eventual delivery, so this helper always preserves the
 * successful deletion response while making immediate Redis failures visible.
 */
export const handoffCommittedEntityDeletionCleanup = async ({
  captureDeliveryError,
  enqueueCleanup,
  requestId,
  timeoutMs = CLEANUP_HANDOFF_TIMEOUT_MS,
}: CleanupHandoffOptions): Promise<void> => {
  const enqueueResult = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await enqueueCleanup(requestId), {
        label: CLEANUP_HANDOFF_TIMEOUT_LABEL,
        timeoutMs,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(enqueueResult)) {
    const captureResult = Result.try({
      try: () => captureDeliveryError(enqueueResult.error, { requestId }),
      catch: (cause) => cause,
    });
    if (Result.isError(captureResult)) {
      logger.warn("entity_deletion_cleanup.delivery_capture_failed", {
        "error.type": errorTag(captureResult.error),
        requestId,
      });
    }
  }
};

type CleanupHandoffBatchOptions = Omit<CleanupHandoffOptions, "requestId"> & {
  max?: number;
  requestIds: SafeId<"entityDeletionCleanupRequest">[];
};

/**
 * Accelerates a bounded prefix of one deletion's committed cleanup requests.
 *
 * A deletion can commit arbitrarily many request rows, but every one of them is
 * already durable and the reconciler claims each `pending` row on its own
 * schedule. Bounding the prefix keeps a large deletion from fanning out an
 * unbounded number of queue calls, or from holding its response open behind the
 * slowest of them; the remainder is not dropped, only left to reconciliation.
 */
export const handoffCommittedEntityDeletionCleanupBatch = async ({
  captureDeliveryError,
  enqueueCleanup,
  max = CLEANUP_HANDOFF_BATCH_MAX,
  requestIds,
  timeoutMs,
}: CleanupHandoffBatchOptions): Promise<void> => {
  await Promise.all(
    requestIds.slice(0, Math.max(max, 0)).map(
      async (requestId) =>
        await handoffCommittedEntityDeletionCleanup({
          captureDeliveryError,
          enqueueCleanup,
          requestId,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
    ),
  );
};
