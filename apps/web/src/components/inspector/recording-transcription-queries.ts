import { queryOptions } from "@tanstack/react-query";

import { RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES } from "@stll/api-contract/recording-transcription";
import type { RecordingTranscriptionRunStatus } from "@stll/api-contract/recording-transcription";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

const RUN_POLL_INTERVAL_MS = 2000;

type RecordingTranscriptionRunRef = { workspaceId: string; runId: string };

const ACTIVE: ReadonlySet<RecordingTranscriptionRunStatus> = new Set(
  RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES,
);

export const isRecordingTranscriptionRunActive = (
  status: RecordingTranscriptionRunStatus,
): boolean => ACTIVE.has(status);

const fetchRecordingTranscriptionRun = async (
  { workspaceId, runId }: RecordingTranscriptionRunRef,
  signal: AbortSignal,
) => {
  const workspace = api.workspaces({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });
  return unwrapApiResponse(
    await workspace["recording-transcriptions"]
      .runs({ runId: toSafeId<"recordingTranscriptionRun">(runId) })
      .get({ fetch: { signal } }),
  );
};

/** A run is polled while it works; it announces nothing over realtime. */
export const recordingTranscriptionRunOptions = (
  ref: RecordingTranscriptionRunRef,
) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: ["recording-transcription-runs", ref],
      queryFn: async ({ signal }) =>
        await fetchRecordingTranscriptionRun(ref, signal),
      retry: shouldRetryAPIRequest,
      staleTime: 0,
      refetchInterval: (query) => {
        const status = query.state.data?.run.status;
        return status !== undefined && isRecordingTranscriptionRunActive(status)
          ? RUN_POLL_INTERVAL_MS
          : false;
      },
    }),
    { type: "independent" },
  );
