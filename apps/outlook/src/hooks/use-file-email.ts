import { useState } from "react";

import { panic, Result } from "better-result";

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
import type { MailSnapshot, WorkspaceSummary } from "@/types";

type FiledMessage = {
  readonly result: FiledEmail;
  readonly skippedAttachments: MessageFile["skippedAttachments"];
  readonly source: MessageFile["source"];
  /** The matter the email went to, as chosen at the click. */
  readonly workspace: WorkspaceSummary;
};

type RetryFinalize = Omit<FiledMessage, "result"> & {
  readonly pending: PendingFinalize;
};

export type FileEmailState =
  | { type: "idle" }
  | { type: "reading" }
  | { type: "uploading" }
  /** Retrying the finalize of an upload stored in `workspace`. */
  | { type: "finalizing"; workspace: WorkspaceSummary }
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
  workspace: WorkspaceSummary;
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

export const isFileEmailActive = (state: FileEmailState): boolean => {
  switch (state.type) {
    case "finalizing":
    case "reading":
    case "uploading":
      return true;
    case "complete":
    case "error":
    case "idle":
      return false;
    default:
      state satisfies never;
      return panic("Unknown filing state");
  }
};

/**
 * The matter of an upload that went through but was not confirmed, also
 * while its finalize is retried. Until it is confirmed, filing finishes that
 * upload there: a new one elsewhere could leave the email in two matters.
 */
export const pendingFinalizeWorkspace = (
  state: FileEmailState,
): WorkspaceSummary | null => {
  switch (state.type) {
    case "error":
      return state.retry?.workspace ?? null;
    case "finalizing":
      return state.workspace;
    case "complete":
    case "idle":
    case "reading":
    case "uploading":
      return null;
    default:
      state satisfies never;
      return panic("Unknown filing state");
  }
};

/**
 * Files the selected message into a matter as one `.eml` document. A
 * finalize that did not answer is kept so "try again" finalizes the stored
 * upload, in its own matter, instead of uploading the message twice.
 */
export const useFileEmail = (messages: FileEmailMessages) => {
  const [state, setState] = useState<FileEmailState>({ type: "idle" });

  const save = async ({
    isCurrent,
    loadLatest,
    snapshot,
    workspace,
  }: SaveArgs) => {
    const retry = state.type === "error" ? state.retry : null;
    let filedMessage: Omit<FiledMessage, "result"> = retry ?? {
      skippedAttachments: [],
      source: "mailbox",
      workspace,
    };
    const filed = await Result.tryPromise({
      catch: (cause) => cause,
      try: async (): Promise<FiledEmail> => {
        if (retry) {
          setState({ type: "finalizing", workspace: retry.workspace });
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
          workspace,
        };
        setState({ type: "uploading" });
        return await fileEmailToMatter({
          eml: message.file,
          workspaceId: workspace.id,
        });
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
                workspace: filedMessage.workspace,
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
      workspace: filedMessage.workspace,
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
