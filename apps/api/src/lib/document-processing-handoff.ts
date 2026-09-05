import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { withTimeout } from "@/api/lib/with-timeout";

export const DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY = 4;
const DOCUMENT_PROCESSING_HANDOFF_TIMEOUT_MS = 2000;
const DOCUMENT_PROCESSING_HANDOFF_TIMEOUT_LABEL = "document-processing.handoff";

type DocumentProcessingHandoffOptions = {
  captureEnqueueError?: typeof captureError;
  enqueue?: typeof enqueueDocumentProcessingRun;
  runIds: readonly SafeId<"documentProcessingRun">[];
  timeoutMs?: number;
};

/**
 * Best-effort acceleration after extraction runs commit. The repair scan owns
 * eventual delivery; this helper bounds immediate Redis work and captures each
 * failed handoff without rejecting the successful copy operation.
 */
export const handoffCommittedDocumentProcessingRuns = async ({
  captureEnqueueError = captureError,
  enqueue = enqueueDocumentProcessingRun,
  runIds,
  timeoutMs = DOCUMENT_PROCESSING_HANDOFF_TIMEOUT_MS,
}: DocumentProcessingHandoffOptions): Promise<void> => {
  for (
    let start = 0;
    start < runIds.length;
    start += DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY
  ) {
    const batch = runIds.slice(
      start,
      start + DOCUMENT_PROCESSING_HANDOFF_CONCURRENCY,
    );
    await Promise.all(
      batch.map(async (runId) => {
        const result = await Result.tryPromise({
          try: async () =>
            await withTimeout(async () => await enqueue(runId), {
              label: DOCUMENT_PROCESSING_HANDOFF_TIMEOUT_LABEL,
              timeoutMs,
            }),
          catch: (cause) => cause,
        });
        if (Result.isError(result)) {
          captureEnqueueError(result.error, { runId });
        }
      }),
    );
  }
};
