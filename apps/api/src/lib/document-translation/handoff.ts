import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { enqueueDocumentTranslationRun } from "@/api/lib/document-translation/run-queue";
import { withTimeout } from "@/api/lib/with-timeout";

const HANDOFF_TIMEOUT_MS = 2000;
const HANDOFF_TIMEOUT_LABEL = "document-translation.handoff";

type DocumentTranslationHandoffOptions = {
  captureDeliveryError?: typeof captureError;
  enqueue?: typeof enqueueDocumentTranslationRun;
  organizationId: SafeId<"organization">;
  runId: SafeId<"documentTranslationRun">;
  timeoutMs?: number;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Best-effort acceleration after the durable run commits. The reconciler owns
 * eventual delivery, so a Redis failure never turns a committed run into a
 * failed or missing translation request.
 */
export const handoffCommittedDocumentTranslationRun = async ({
  captureDeliveryError = captureError,
  enqueue = enqueueDocumentTranslationRun,
  organizationId,
  runId,
  timeoutMs = HANDOFF_TIMEOUT_MS,
  userId,
  workspaceId,
}: DocumentTranslationHandoffOptions): Promise<void> => {
  const result = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () =>
          await enqueue({ runId, organizationId, workspaceId, userId }),
        { label: HANDOFF_TIMEOUT_LABEL, timeoutMs },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureDeliveryError(result.error, { runId, workspaceId });
  }
};
