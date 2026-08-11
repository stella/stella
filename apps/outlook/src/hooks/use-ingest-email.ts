import { useState } from "react";

import { Result, panic } from "better-result";

import type { OutlookIngestionRetryStage } from "@stll/api-contract";

import {
  abortEmailUploadReservation,
  finalizeEmailUpload,
  reconcileEmailUpload,
  reserveEmailUpload,
  shouldRetainPendingEmailUpload,
  uploadReservedEmail,
} from "@/api";
import { OUTLOOK_INGESTION_CONFIG } from "@/ingestion-config";
import {
  type AbortingEmailUpload,
  type FinalizingEmailUpload,
  type IngestEmailResult,
  type IngestState,
  isIngestActive,
  type PendingEmailUpload,
  type ReservedEmailUpload,
  transitionIngestState,
  type UploadingEmailUpload,
} from "@/ingestion-state";
import { mapConcurrent } from "@/lib/bounded-concurrency";
import {
  createIngestionDiagnosticBase,
  diagnosticBase,
  ingestionDiagnostic,
} from "@/lib/ingestion-diagnostics";
import { APIError, userErrorMessage } from "@/lib/api-error";
import { isAttachmentReadError } from "@/lib/outlook-error";
import { downloadAttachment } from "@/outlook";
import type { MailSnapshot } from "@/types";

type IngestArgs = {
  isCurrent: (itemInstanceKey: string) => boolean;
  loadLatest: () => Promise<MailSnapshot>;
  selectedAttachmentIds: Set<string> | null;
  snapshot: MailSnapshot;
  workspaceId: string;
};

type UseIngestEmail = {
  reset: () => void;
  save: (args: IngestArgs) => void;
  state: IngestState;
};

type PendingEmailUploadStore = {
  getPendingEmailUpload: () => PendingEmailUpload | null;
  setPendingEmailUpload: (value: PendingEmailUpload | null) => void;
};

type UseIngestEmailOptions = PendingEmailUploadStore & {
  attachmentErrorFallback: string;
  errorFallback: string;
};

const selectedAttachments = (
  snapshot: MailSnapshot,
  selectedAttachmentIds: Set<string> | null,
) =>
  snapshot.attachments.filter(
    (attachment) =>
      attachment.isInline ||
      selectedAttachmentIds === null ||
      selectedAttachmentIds.has(attachment.id),
  );

const withDiagnostic = (
  pending: PendingEmailUpload,
  retryStage: OutlookIngestionRetryStage,
): PendingEmailUpload => {
  const diagnostic = ingestionDiagnostic(
    diagnosticBase(pending.diagnostic),
    retryStage,
    "in_progress",
  );
  switch (pending.type) {
    case "reserved":
      return {
        diagnostic,
        eml: pending.eml,
        headers: pending.headers,
        skippedAttachments: pending.skippedAttachments,
        type: "reserved",
        uploadId: pending.uploadId,
        url: pending.url,
        workspaceId: pending.workspaceId,
      };
    case "uploading":
      return {
        diagnostic,
        eml: pending.eml,
        headers: pending.headers,
        skippedAttachments: pending.skippedAttachments,
        type: "uploading",
        uploadId: pending.uploadId,
        url: pending.url,
        workspaceId: pending.workspaceId,
      };
    case "finalizing":
      return {
        diagnostic,
        skippedAttachments: pending.skippedAttachments,
        type: "finalizing",
        uploadId: pending.uploadId,
        workspaceId: pending.workspaceId,
      };
    case "aborting":
      return {
        diagnostic,
        type: "aborting",
        uploadId: pending.uploadId,
        workspaceId: pending.workspaceId,
      };
    default:
      return panic("Unknown pending Outlook ingestion state");
  }
};

const toUploading = (reserved: ReservedEmailUpload): UploadingEmailUpload => ({
  diagnostic: ingestionDiagnostic(
    diagnosticBase(reserved.diagnostic),
    "upload",
    "in_progress",
  ),
  eml: reserved.eml,
  headers: reserved.headers,
  skippedAttachments: reserved.skippedAttachments,
  type: "uploading",
  uploadId: reserved.uploadId,
  url: reserved.url,
  workspaceId: reserved.workspaceId,
});

const toFinalizing = (
  pending: PendingEmailUpload,
): FinalizingEmailUpload => ({
  diagnostic: ingestionDiagnostic(
    diagnosticBase(pending.diagnostic),
    "finalize",
    "in_progress",
  ),
  skippedAttachments:
    pending.type === "aborting" ? [] : pending.skippedAttachments,
  type: "finalizing",
  uploadId: pending.uploadId,
  workspaceId: pending.workspaceId,
});

const toAborting = (pending: PendingEmailUpload): AbortingEmailUpload => ({
  diagnostic: ingestionDiagnostic(
    diagnosticBase(pending.diagnostic),
    "abort",
    "in_progress",
  ),
  type: "aborting",
  uploadId: pending.uploadId,
  workspaceId: pending.workspaceId,
});

const PENDING_RETRY_STAGE = {
  aborting: "abort",
  finalizing: "finalize",
  reserved: "upload",
  uploading: "upload",
} as const satisfies Record<
  PendingEmailUpload["type"],
  OutlookIngestionRetryStage
>;

export const useIngestEmail = ({
  attachmentErrorFallback,
  errorFallback,
  getPendingEmailUpload,
  setPendingEmailUpload,
}: UseIngestEmailOptions): UseIngestEmail => {
  const [state, setState] = useState<IngestState>({ type: "idle" });
  const transition = (next: IngestState) =>
    setState((current) => transitionIngestState(current, next));
  const remember = (pending: PendingEmailUpload) => {
    setPendingEmailUpload(pending);
    transition(pending);
  };

  const abortPending = async (pending: PendingEmailUpload): Promise<void> => {
    const aborting = toAborting(pending);
    remember(aborting);
    await abortEmailUploadReservation(
      aborting.workspaceId,
      aborting.uploadId,
      aborting.diagnostic,
    );
    setPendingEmailUpload(null);
  };

  const uploadPending = async (
    pending: ReservedEmailUpload | UploadingEmailUpload,
  ): Promise<FinalizingEmailUpload> => {
    const uploading =
      pending.type === "reserved" ? toUploading(pending) : pending;
    remember(uploading);
    const finalizing = await uploadReservedEmail(uploading, {
      onAborted: () => setPendingEmailUpload(null),
      onAborting: (aborting) => remember(aborting),
    });
    remember(finalizing);
    return finalizing;
  };

  const resumePending = async (
    pending: PendingEmailUpload,
  ): Promise<IngestEmailResult | null> => {
    const reconciling = withDiagnostic(pending, "reconcile");
    remember(reconciling);
    const reconciliation = await reconcileEmailUpload(reconciling);
    switch (reconciliation.state) {
      case "complete":
        return reconciliation.result;
      case "rejected":
        setPendingEmailUpload(null);
        if (pending.type === "aborting") {
          return null;
        }
        throw new APIError({ message: reconciliation.reason, status: 422 });
      case "finalizing":
        remember(toFinalizing(pending));
        throw new APIError({
          message: "Finalize already in progress for this upload",
          status: 409,
        });
      case "retryable": {
        if (pending.type === "aborting") {
          await abortPending(pending);
          return null;
        }
        const finalizing = toFinalizing(pending);
        remember(finalizing);
        return await finalizeEmailUpload(finalizing);
      }
      case "reserved":
        if (pending.type === "aborting") {
          await abortPending(pending);
          return null;
        }
        if (pending.type === "finalizing") {
          return await finalizeEmailUpload(pending);
        }
        return await finalizeEmailUpload(await uploadPending(pending));
    }
  };

  const save = async ({
    isCurrent,
    loadLatest,
    selectedAttachmentIds,
    snapshot,
    workspaceId,
  }: IngestArgs) => {
    const initialAttachments = selectedAttachments(
      snapshot,
      selectedAttachmentIds,
    );
    let attemptBase = createIngestionDiagnosticBase(initialAttachments);
    const existingPending = getPendingEmailUpload();
    if (existingPending) {
      attemptBase = diagnosticBase(existingPending.diagnostic);
      transition(withDiagnostic(existingPending, "reconcile"));
    } else {
      transition({
        diagnostic: ingestionDiagnostic(
          attemptBase,
          "reserve",
          "in_progress",
        ),
        type: "downloading",
      });
    }

    const result = await Result.tryPromise({
      try: async () => {
        const pendingUpload = getPendingEmailUpload();
        if (
          pendingUpload &&
          pendingUpload.type !== "aborting" &&
          pendingUpload.workspaceId !== workspaceId
        ) {
          throw new APIError({ message: errorFallback, status: 409 });
        }
        if (pendingUpload) {
          const resumed = await resumePending(pendingUpload);
          if (resumed) {
            return resumed;
          }
          transition({
            diagnostic: ingestionDiagnostic(
              attemptBase,
              "reserve",
              "in_progress",
            ),
            type: "downloading",
          });
        }

        const latest = await loadLatest();
        const attachments = selectedAttachments(latest, selectedAttachmentIds);
        const latestBase = createIngestionDiagnosticBase(attachments);
        attemptBase = { ...latestBase, traceId: attemptBase.traceId };
        transition({
          diagnostic: ingestionDiagnostic(
            attemptBase,
            "reserve",
            "in_progress",
          ),
          type: "downloading",
        });
        const downloaded = await mapConcurrent({
          concurrency:
            OUTLOOK_INGESTION_CONFIG.attachmentDownloadConcurrency,
          items: attachments,
          map: downloadAttachment,
        });
        if (!isCurrent(latest.itemInstanceKey)) {
          throw new APIError({ message: errorFallback, status: 409 });
        }
        const reserved = await reserveEmailUpload({
          attachments: downloaded,
          diagnostic: ingestionDiagnostic(
            attemptBase,
            "upload",
            "in_progress",
          ),
          snapshot: latest,
          workspaceId,
        });
        remember(reserved);
        return await finalizeEmailUpload(await uploadPending(reserved));
      },
      catch: (cause) => cause,
    });

    if (Result.isError(result)) {
      const { error } = result;
      const pending = getPendingEmailUpload();
      const retain =
        pending !== null && shouldRetainPendingEmailUpload(error);
      if (!retain) {
        setPendingEmailUpload(null);
      }
      const retryStage = pending
        ? PENDING_RETRY_STAGE[pending.type]
        : "reserve";
      const diagnostic = ingestionDiagnostic(
        pending ? diagnosticBase(pending.diagnostic) : attemptBase,
        retryStage,
        retain ? "retryable_failure" : "terminal_failure",
      );
      transition({
        diagnostic,
        message:
          isAttachmentReadError(error)
            ? attachmentErrorFallback
            : error instanceof APIError
            ? userErrorMessage(error, errorFallback)
            : errorFallback,
        pendingUpload: retain ? pending : null,
        type: "error",
      });
      return;
    }

    setPendingEmailUpload(null);
    transition({
      ...result.value,
      diagnostic: ingestionDiagnostic(attemptBase, "none", "complete"),
      type: "complete",
    });
  };

  return {
    reset: () => {
      if (isIngestActive(state)) {
        return;
      }
      transition({ type: "idle" });
    },
    save: (args) => {
      if (isIngestActive(state)) {
        return;
      }
      save(args).catch(() => {
        const diagnostic = ingestionDiagnostic(
          createIngestionDiagnosticBase([]),
          "reserve",
          "terminal_failure",
        );
        setState({
          diagnostic,
          message: errorFallback,
          pendingUpload: getPendingEmailUpload(),
          type: "error",
        });
      });
    },
    state,
  };
};
