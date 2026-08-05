import { useState } from "react";

import { Result } from "better-result";

import { ingestEmailToMatter } from "@/api";
import { APIError, userErrorMessage } from "@/lib/api-error";
import { downloadAttachment } from "@/outlook";
import type {
  AttachmentDownloadResult,
  MailSnapshot,
  OutlookAttachment,
} from "@/types";

export type IngestState =
  | { type: "idle" }
  | { type: "saving" }
  | {
      attachmentCount: number;
      entityId: string;
      skippedAttachments: string[];
      type: "saved";
      workspaceId: string;
    }
  | { message: string; type: "error" };

type IngestArgs = {
  attachments: OutlookAttachment[];
  snapshot: MailSnapshot;
  workspaceId: string;
};

type UseIngestEmail = {
  reset: () => void;
  save: (args: IngestArgs) => void;
  state: IngestState;
};

export const useIngestEmail = (errorFallback: string): UseIngestEmail => {
  const [state, setState] = useState<IngestState>({ type: "idle" });

  const save = async ({ attachments, snapshot, workspaceId }: IngestArgs) => {
    setState({ type: "saving" });
    const result = await Result.tryPromise(async () => {
      const downloaded: AttachmentDownloadResult[] = await Promise.all(
        attachments.map(
          async (attachment) => await downloadAttachment(attachment),
        ),
      );
      return await ingestEmailToMatter({
        attachments: downloaded,
        snapshot,
        workspaceId,
      });
    });

    if (Result.isError(result)) {
      const { error } = result;
      setState({
        message:
          error instanceof APIError
            ? userErrorMessage(error, errorFallback)
            : errorFallback,
        type: "error",
      });
      return;
    }

    setState({
      attachmentCount: result.value.attachmentCount,
      entityId: result.value.entityId,
      skippedAttachments: result.value.skippedAttachments,
      type: "saved",
      workspaceId,
    });
  };

  return {
    reset: () => setState({ type: "idle" }),
    save: (args) => void save(args),
    state,
  };
};
