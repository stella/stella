import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { enqueuePdfAnonymizationRun } from "@/api/lib/pdf-anonymization/run-queue";
import { withTimeout } from "@/api/lib/with-timeout";

const HANDOFF_TIMEOUT_MS = 2000;

export const handoffCommittedPdfAnonymizationRun = async ({
  organizationId,
  runId,
  userId,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  runId: SafeId<"pdfAnonymizationRun">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  const result = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () =>
          await enqueuePdfAnonymizationRun({
            runId,
            organizationId,
            workspaceId,
            userId,
          }),
        {
          label: "pdf-anonymization.handoff",
          timeoutMs: HANDOFF_TIMEOUT_MS,
        },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureError(result.error, { runId, workspaceId });
  }
};
