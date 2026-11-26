import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { withTimeout } from "@/api/lib/with-timeout";

import { enqueueRecordingTranscriptionRun } from "./run-queue";

const HANDOFF_TIMEOUT_MS = 2000;

const handoffFailure = failureSink({
  event: "recording_transcription.handoff_failed",
  expected: [],
});

/**
 * Best-effort acceleration after the durable run commits. The reconciler owns
 * eventual delivery, so a Redis failure never loses a committed run.
 */
export const handoffCommittedRecordingTranscriptionRun = async (args: {
  organizationId: SafeId<"organization">;
  runId: SafeId<"recordingTranscriptionRun">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  const result = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () => await enqueueRecordingTranscriptionRun(args),
        {
          label: "recording-transcription.handoff",
          timeoutMs: HANDOFF_TIMEOUT_MS,
        },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: handoffFailure });
  }
};
