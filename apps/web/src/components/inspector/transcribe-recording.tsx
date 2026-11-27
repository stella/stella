import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { RecordingTranscriptionRunErrorCode } from "@stll/api-contract/recording-transcription";
import { Button } from "@stll/ui/button";
import { FileAudioIcon, FileTextIcon, RotateCcwIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import { openEntityInInspector } from "@/components/chat/entity-open";
import {
  isRecordingTranscriptionRunActive,
  recordingTranscriptionRunOptions,
} from "@/components/inspector/recording-transcription-queries";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";
import { toSafeId } from "@/lib/safe-id";
import { resourceMutation } from "@/lib/workspace-realtime";
import { getCurrentWorkspaceDocument } from "@/lib/workspaces/use-workspace-view-params";

const FAILURE_KEYS = {
  document_changed: "inspector.transcribe.failed.changed",
  document_unresolved: "inspector.transcribe.failed.generic",
  internal: "inspector.transcribe.failed.generic",
  no_speech: "inspector.transcribe.failed.noSpeech",
  provider_unavailable: "inspector.transcribe.failed.provider",
  too_long: "inspector.transcribe.failed.tooLong",
  transcription_failed: "inspector.transcribe.failed.generic",
  unsupported_format: "inspector.transcribe.failed.unsupported",
} as const satisfies Record<RecordingTranscriptionRunErrorCode, TranslationKey>;

type TranscribeRecordingProps = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  openDocument?: typeof openEntityInInspector;
};

/**
 * Starts a transcription of the open recording and follows it until the
 * transcript is saved beside it.
 */
export const TranscribeRecording = ({
  workspaceId,
  entityId,
  fieldId,
  openDocument = openEntityInInspector,
}: TranscribeRecordingProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const router = useRouter();
  const submit = useIdempotentSubmit();
  // shortcut: the run is remembered only while the recording stays open;
  // reopening it offers Transcribe again (a second start while one runs is
  // refused by the API). Upgrade with a latest-run read for the file.
  const [runId, setRunId] = useState<string | null>(null);

  const workspace = api.workspaces({
    workspaceId: toSafeId<"workspace">(workspaceId),
  });

  const startRun = resourceMutation({
    mutation: "startRecordingTranscription",
    queryClient,
    mutationFn: async (_: { workspaceId: string }) =>
      unwrapApiResponse(
        await submit.run({
          operation: `recording-transcription.${workspaceId}.${fieldId}`,
          body: {
            entityId: toSafeId<"entity">(entityId),
            fieldId: toSafeId<"field">(fieldId),
          },
          send: async (body, replayRequest) =>
            await invokeCapability(
              "recording-transcriptions.runs.create",
              async (request) => {
                const reply = await workspace[
                  "recording-transcriptions"
                ].runs.post(body, {
                  ...request,
                  headers: {
                    "Idempotency-Key": replayRequest.headers["Idempotency-Key"],
                    ...request.headers,
                  },
                });
                unwrapApiResponse(reply);
                return reply;
              },
            ),
        }),
      ),
  });
  const start = useMutation({
    mutationFn: async () => await startRun({ workspaceId }),
    onSuccess: (data) => {
      submit.reset();
      setRunId(data.runId);
    },
  });

  const runQuery = useQuery({
    ...recordingTranscriptionRunOptions({ workspaceId, runId: runId ?? "" }),
    enabled: runId !== null,
  });
  const run = runQuery.data?.run;

  const retry = () => {
    if (start.isPending) {
      return;
    }
    if (
      runId !== null &&
      run?.status !== "failed" &&
      run?.status !== "cancelled"
    ) {
      detached(runQuery.refetch(), "transcribe-recording.refetch");
      return;
    }
    setRunId(null);
    start.mutate();
  };

  if (run !== undefined && isRecordingTranscriptionRunActive(run.status)) {
    const percent =
      run.durationMs === null || run.durationMs === 0
        ? null
        : Math.min(100, Math.round((run.transcribedMs / run.durationMs) * 100));
    return (
      <p
        aria-live="polite"
        className="text-muted-foreground flex items-center gap-2 text-sm"
        role="status"
      >
        <Loader className="size-4" size="sm" variant="decorative" />
        {percent === null
          ? t("chat.dictationTranscribing")
          : t("inspector.transcribe.progress", { percent })}
      </p>
    );
  }

  if (run?.status === "completed") {
    const { outputEntityId, outputFieldId, outputFileName } = run;
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
        <span role="status">
          {t("inspector.transcribe.saved", { fileName: outputFileName ?? "" })}
        </span>
        {outputEntityId !== null && outputFieldId !== null && (
          <Button
            onClick={() => {
              detached(
                openDocument({
                  documentOnScreen: getCurrentWorkspaceDocument(
                    router.state.matches,
                  ),
                  entityId: outputEntityId,
                  fieldId: outputFieldId,
                  label: outputFileName ?? "",
                  workspaceId,
                }),
                "transcribe-recording.open",
              );
            }}
            size="sm"
            variant="outline"
          >
            <FileTextIcon />
            {t("common.open")}
          </Button>
        )}
      </div>
    );
  }

  const failureMessage = () => {
    if (run?.status === "failed" || run?.status === "cancelled") {
      return t(
        run.errorCode === null
          ? "inspector.transcribe.failed.generic"
          : FAILURE_KEYS[run.errorCode],
      );
    }
    const error = start.error ?? runQuery.error;
    return error === null
      ? null
      : userErrorFromThrown(error, t("inspector.transcribe.failed.generic"));
  };
  const failure = failureMessage();

  if (failure !== null) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-sm">
        <p className="text-destructive" role="alert">
          {failure}
        </p>
        <Button onClick={retry} size="sm" variant="outline">
          <RotateCcwIcon />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <CapabilityAction action={{ capability: "ai" }} surface="control">
      {(capabilityProps) => (
        <Button
          onClick={() => {
            if (start.isPending || runId !== null) {
              return;
            }
            start.mutate();
          }}
          size="sm"
          variant="outline"
          {...capabilityProps}
        >
          <FileAudioIcon />
          {t("inspector.transcribe.action")}
        </Button>
      )}
    </CapabilityAction>
  );
};
