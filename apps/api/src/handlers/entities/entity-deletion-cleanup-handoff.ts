import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { withTimeout } from "@/api/lib/with-timeout";

const CLEANUP_HANDOFF_TIMEOUT_MS = 2000;
const CLEANUP_HANDOFF_TIMEOUT_LABEL = "entity-deletion-cleanup.handoff";

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
    captureDeliveryError(enqueueResult.error, { requestId });
  }
};
