/**
 * A stored mailbox (`.mbox`, Outlook `.pst`) as the Files preview and every
 * reader of documents read it: its messages' list for the viewer, and its
 * text for chat, workflows, agents and document reads. Neither ever loads
 * the mailbox whole; each keeps the stored file's access, liveness and
 * delivery audit.
 */
import { Result } from "better-result";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import {
  MAILBOX_FILE_FORMATS,
  MAILBOX_FILE_KINDS,
  MBOX_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import type { MailboxPreview } from "@stll/api-contract/mailbox";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { ARCHIVE_PREVIEW_WORKER_EXIT } from "@/api/lib/files/archive-preview-protocol";
import {
  type LegalFileReadOptions,
  openLegalFileSource,
} from "@/api/lib/files/legal-file-source";
import {
  MAILBOX_READ_TIMEOUT_MS,
  readStoredMailboxPreview,
} from "@/api/lib/files/mailbox-file";
import { readStoredMailboxText } from "@/api/lib/files/mailbox-stream-text";
import { readStoredPstPreview } from "@/api/lib/files/pst-file";
import { LIMITS } from "@/api/lib/limits";

const unreadable = () =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message: "The mailbox could not be read",
  });

const formatOf = (kind: string) =>
  MAILBOX_FILE_FORMATS.find((format) => format.kind === kind) ??
  MBOX_FILE_FORMAT;

/** A stored mailbox's messages, as the viewer lists them. */
export const readMailboxPreview = async (
  options: LegalFileReadOptions,
): Promise<Result<MailboxPreview, HandlerError>> => {
  const opened = await openLegalFileSource(options, MAILBOX_FILE_KINDS);
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const { key, fileName, deliver, format } = opened.value;
  const stored = {
    key,
    fileName,
    signal: AbortSignal.timeout(MAILBOX_READ_TIMEOUT_MS),
  };
  const preview =
    format.kind === "pst"
      ? (await readStoredPstPreview(stored)).mapError((error) =>
          "_tag" in error ? error : unreadable(),
        )
      : (await readStoredMailboxPreview(stored)).mapError(() => unreadable());
  if (preview.isErr()) {
    return Result.err(preview.error);
  }
  const listed = preview.value;
  return await deliver((): Result<MailboxPreview, HandlerError> =>
    Result.ok(listed),
  );
};

/**
 * A stored mailbox's text: each message's header, body and attachments'
 * names, one message at a time, within the extracted-text budget.
 */
export const readMailboxContent = async (
  options: LegalFileReadOptions,
): Promise<Result<{ text: string; attachments: never[] }, HandlerError>> => {
  const opened = await openLegalFileSource(options, MAILBOX_FILE_KINDS);
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const { key, fileName, deliver, format } = opened.value;
  const text = await readStoredMailboxText({
    key,
    fileName,
    format: formatOf(format.kind),
    maxChars: LIMITS.extractedContentMaxChars,
    signal: AbortSignal.timeout(MAILBOX_READ_TIMEOUT_MS),
    timeoutMs: MAILBOX_READ_TIMEOUT_MS,
  });
  if (text.isErr()) {
    return Result.err(
      text.error.exitCode === ARCHIVE_PREVIEW_WORKER_EXIT.unreadable
        ? unreadable()
        : new HandlerError({
            status: 503,
            code: "upstream_unavailable",
            message: "The mailbox reader is unavailable",
            cause: text.error,
          }),
    );
  }
  const read = text.value ?? "";
  return await deliver(
    (): Result<{ text: string; attachments: never[] }, HandlerError> =>
      Result.ok({ text: read, attachments: [] }),
  );
};
