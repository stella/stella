import { useState } from "react";

import { Result } from "better-result";

import type { SafeId } from "@stll/api-contract";

import {
  type FiledEmail,
  FileEmailError,
  fileEmailToMatter,
  finalizeFiledEmail,
  FinalizePendingError,
  type PendingFinalize,
} from "@/api";
import { type MessageFile, readMessageFile } from "@/lib/message-file";
import {
  OutlookAPIError,
  outlookUserErrorMessage,
} from "@/lib/outlook-api-error";
import { isAttachmentReadError, OutlookError } from "@/lib/outlook-error";
import type { MailSnapshot } from "@/types";

type FiledMessage = {
  readonly result: FiledEmail;
  readonly skippedAttachments: MessageFile["skippedAttachments"];
  readonly source: MessageFile["source"];
};

type RetryFinalize = Omit<FiledMessage, "result"> & {
  readonly pending: PendingFinalize;
};

export type FileEmailState =
  | { type: "idle" }
  | { type: "reading" }
  | { type: "uploading" }
  | (FiledMessage & { type: "complete" })
  | { message: string; retry: RetryFinalize | null; type: "error" };

export type FileEmailMessages = {
  attachmentError: string;
  errorFallback: string;
  itemChanged: string;
  noFileColumn: string;
  notFinalized: string;
  tooLarge: string;
};

type SaveArgs = {
  isCurrent: (itemInstanceKey: string) => boolean;
  loadLatest: () => Promise<MailSnapshot>;
  snapshot: MailSnapshot;
  workspaceId: SafeId<"workspace">;
};

const errorMessage = (error: unknown, messages: FileEmailMessages): string => {
  if (error instanceof FinalizePendingError) {
    return messages.notFinalized;
  }
  if (error instanceof FileEmailError) {
    return error.failure === "too-large"
      ? messages.tooLarge
      : messages.noFileColumn;
  }
  if (isAttachmentReadError(error)) {
    return messages.attachmentError;
  }
  if (error instanceof OutlookAPIError) {
    return outlookUserErrorMessage(error, messages.errorFallback);
  }
  if (error instanceof OutlookError) {
    return error.message;
  }
  return messages.errorFallback;
};

export const isFileEmailActive = (state: FileEmailState): boolean =>
  state.type === "reading" || state.type === "uploading";

/**
 * Files the selected message into a matter as one `.eml` document. A
 * finalize that did not answer is kept so "try again" finalizes the stored
 * upload instead of uploading the message twice.
 */
export const useFileEmail = (messages: FileEmailMessages) => {
  const [state, setState] = useState<FileEmailState>({ type: "idle" });

  const save = async ({
    isCurrent,
    loadLatest,
    snapshot,
    workspaceId,
  }: SaveArgs) => {
    const retry =
      state.type === "error" && state.retry?.pending.workspaceId === workspaceId
        ? state.retry
        : null;
    let filedMessage: Omit<FiledMessage, "result"> = retry ?? {
      skippedAttachments: [],
      source: "mailbox",
    };
    const filed = await Result.tryPromise({
      catch: (cause) => cause,
      try: async (): Promise<FiledEmail> => {
        if (retry) {
          setState({ type: "uploading" });
          return await finalizeFiledEmail(retry.pending);
        }
        setState({ type: "reading" });
        const latest = await loadLatest();
        const stillSelected = () =>
          latest.itemInstanceKey === snapshot.itemInstanceKey &&
          isCurrent(latest.itemInstanceKey);
        if (!stillSelected()) {
          throw new OutlookError({ message: messages.itemChanged });
        }
        const message = await readMessageFile(latest);
        if (!stillSelected()) {
          throw new OutlookError({ message: messages.itemChanged });
        }
        filedMessage = {
          skippedAttachments: message.skippedAttachments,
          source: message.source,
        };
        setState({ type: "uploading" });
        return await fileEmailToMatter({ eml: message.file, workspaceId });
      },
    });
    if (Result.isError(filed)) {
      const { error } = filed;
      setState({
        message: errorMessage(error, messages),
        retry:
          error instanceof FinalizePendingError
            ? {
                pending: error.pending,
                skippedAttachments: filedMessage.skippedAttachments,
                source: filedMessage.source,
              }
            : null,
        type: "error",
      });
      return;
    }
    setState({
      result: filed.value,
      skippedAttachments: filedMessage.skippedAttachments,
      source: filedMessage.source,
      type: "complete",
    });
  };

  return {
    save: (args: SaveArgs) => {
      if (isFileEmailActive(state)) {
        return;
      }
      save(args).catch(() => {
        setState({
          message: messages.errorFallback,
          retry: null,
          type: "error",
        });
      });
    },
    state,
  };
};
