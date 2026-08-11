import { useRef, useState } from "react";

import { Result } from "better-result";

import {
  abortEmailUploadReservation,
  finalizeEmailUpload,
  PendingUploadCleanupError,
  prepareEmailUpload,
  shouldRetainPendingEmailUpload,
} from "@/api";
import type { PendingEmailUpload } from "@/api";
import { APIError, userErrorMessage } from "@/lib/api-error";
import { downloadAttachment } from "@/outlook";
import type { AttachmentDownloadResult, MailSnapshot } from "@/types";

export type IngestState =
  | { type: "idle" }
  | { type: "saving" }
  | {
      attachmentCount: number;
      entityId: string;
      fieldId: string;
      skippedAttachments: string[];
      type: "saved";
      workspaceId: string;
    }
  | { message: string; type: "error" };

type IngestArgs = {
  isCurrent: (itemInstanceKey: string) => boolean;
  loadLatest: () => Promise<MailSnapshot>;
  selectedAttachmentIds: Set<string> | null;
  workspaceId: string;
};

type UseIngestEmail = {
  reset: () => void;
  save: (args: IngestArgs) => void;
  state: IngestState;
};

export const useIngestEmail = (errorFallback: string): UseIngestEmail => {
  const [state, setState] = useState<IngestState>({ type: "idle" });
  const pendingUpload = useRef<PendingEmailUpload | null>(null);

  const save = async ({
    isCurrent,
    loadLatest,
    selectedAttachmentIds,
    workspaceId,
  }: IngestArgs) => {
    setState({ type: "saving" });
    const result = await Result.tryPromise(async () => {
      if (
        pendingUpload.current &&
        pendingUpload.current.workspaceId !== workspaceId
      ) {
        throw new APIError({
          message: errorFallback,
          status: 409,
        });
      }
      if (pendingUpload.current?.type === "abort") {
        await abortEmailUploadReservation(
          pendingUpload.current.workspaceId,
          pendingUpload.current.uploadId,
        );
        pendingUpload.current = null;
      }
      if (pendingUpload.current?.type === "finalize") {
        return await finalizeEmailUpload(pendingUpload.current);
      }

      const snapshot = await loadLatest();
      const attachments = snapshot.attachments.filter(
        (attachment) =>
          !attachment.isInline &&
          (selectedAttachmentIds === null ||
            selectedAttachmentIds.has(attachment.id)),
      );
      const downloaded: AttachmentDownloadResult[] = await Promise.all(
        attachments.map(
          async (attachment) => await downloadAttachment(attachment),
        ),
      );
      if (!isCurrent(snapshot.itemInstanceKey)) {
        throw new APIError({ message: errorFallback, status: 409 });
      }
      const prepared = await prepareEmailUpload({
        attachments: downloaded,
        snapshot,
        workspaceId,
      });
      pendingUpload.current = prepared;
      return await finalizeEmailUpload(prepared);
    });

    if (Result.isError(result)) {
      const { error } = result;
      if (error instanceof PendingUploadCleanupError) {
        pendingUpload.current = error.pendingUpload;
      } else if (!shouldRetainPendingEmailUpload(error)) {
        pendingUpload.current = null;
      }
      setState({
        message:
          error instanceof APIError
            ? userErrorMessage(error, errorFallback)
            : errorFallback,
        type: "error",
      });
      return;
    }

    pendingUpload.current = null;
    setState({
      attachmentCount: result.value.attachmentCount,
      entityId: result.value.entityId,
      fieldId: result.value.fieldId,
      skippedAttachments: result.value.skippedAttachments,
      type: "saved",
      workspaceId: result.value.workspaceId,
    });
  };

  return {
    reset: () => setState({ type: "idle" }),
    save: (args) => {
      save(args).catch(() =>
        setState({ message: errorFallback, type: "error" }),
      );
    },
    state,
  };
};
