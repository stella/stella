/**
 * A stored Outlook mailbox (`.pst`), read without holding it in memory: the
 * stored object is streamed into the extraction worker, which writes it to
 * a private temporary file and reads it at an offset, then answers with the
 * mailbox's list or one message as the email it opens as.
 */
import { Result } from "better-result";
import * as v from "valibot";

import {
  type MailboxPreview,
  mailboxPreviewSchema,
} from "@stll/api-contract/mailbox";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FileKey } from "@/api/lib/file-key";
import {
  PST_WORKER_EXIT,
  PST_WORKER_MODE,
  pstWorkerArguments,
} from "@/api/lib/files/archive-preview-protocol";
import {
  decodeEmbeddedPart,
  type EmbeddedPart,
} from "@/api/lib/files/embedded-part-protocol";
import {
  openStoredMailbox,
  streamOf,
} from "@/api/lib/files/mailbox-stream-text";
import { MBOX_MESSAGE_MAX_BYTES } from "@/api/lib/files/mbox";
import { LIMITS } from "@/api/lib/limits";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

/** How long the worker may take over a stored mailbox's list or message. */
export const PST_READ_TIMEOUT_MS = LIMITS.extractionTimeoutMs;

/** A list's reply: a row per message, at most the list's bound. */
const LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Room for the reply's header line: a message's name and type. */
const MESSAGE_HEADER_MAX_BYTES = 4096;

const PREVIEW_REPLY = v.pipe(v.string(), v.parseJson(), mailboxPreviewSchema);

type StoredPst = {
  readonly key: FileKey;
  /** The mailbox's file name, which a message without a subject takes. */
  readonly fileName: string;
  readonly signal: AbortSignal;
};

/** Why a stored mailbox, or one of its messages, is not read. */
export type StoredPstRefusal =
  | { readonly type: "unreadable" }
  | { readonly type: "noMessage" }
  | { readonly type: "tooLarge" };

const unavailable = (cause: unknown) =>
  new HandlerError({
    status: 503,
    code: "upstream_unavailable",
    message: "The mailbox reader is unavailable",
    cause,
  });

const invalidReply = () =>
  classifyFailure(
    new HandlerError({
      status: 500,
      message: "Invalid response from the mailbox reader",
    }),
    "response_invalid",
  );

/**
 * The worker's answer, or why it gave none: a refusal of the mailbox, or a
 * failure of the worker or of the store's read.
 */
const askWorker = async ({
  key,
  signal,
  args,
  maxOutputBytes,
}: Pick<StoredPst, "key" | "signal"> & {
  args: string[];
  maxOutputBytes: number;
}): Promise<Result<Uint8Array, StoredPstRefusal | HandlerError>> => {
  const opened = await openStoredMailbox({ key, signal });
  const { stream, state } = streamOf(opened.chunks);
  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args,
    stdin: stream,
    timeoutMs: PST_READ_TIMEOUT_MS,
    signal,
    maxOutputBytes,
  });
  // A worker that read only part of the mailbox never answers for all of it.
  if (state.failure !== undefined) {
    return Result.err(unavailable(state.failure));
  }
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  const { exitCode } = result.error;
  if (exitCode === PST_WORKER_EXIT.unreadable) {
    return Result.err({ type: "unreadable" });
  }
  if (exitCode === PST_WORKER_EXIT.noMessage) {
    return Result.err({ type: "noMessage" });
  }
  if (exitCode === PST_WORKER_EXIT.tooLarge) {
    return Result.err({ type: "tooLarge" });
  }
  return Result.err(unavailable(result.error));
};

/** A stored mailbox's messages as its list shows them. */
export const readStoredPstPreview = async ({
  key,
  fileName,
  signal,
}: StoredPst): Promise<
  Result<MailboxPreview, StoredPstRefusal | HandlerError>
> => {
  const reply = await askWorker({
    key,
    signal,
    args: [
      PST_WORKER_MODE.list,
      String(LIMITS.extractedContentMaxChars),
      ...pstWorkerArguments({
        mailboxName: fileName,
        timeoutMs: PST_READ_TIMEOUT_MS,
      }),
    ],
    maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
  });
  if (reply.isErr()) {
    return Result.err(reply.error);
  }
  const parsed = v.safeParse(
    PREVIEW_REPLY,
    new TextDecoder().decode(reply.value),
  );
  return parsed.success ? Result.ok(parsed.output) : Result.err(invalidReply());
};

/** One message of a stored mailbox, as the email it opens as. */
export const readStoredPstMessage = async ({
  index,
  ...stored
}: StoredPst & { readonly index: number }): Promise<
  Result<EmbeddedPart, StoredPstRefusal | HandlerError>
> => {
  const reply = await askWorker({
    ...stored,
    args: [
      PST_WORKER_MODE.message,
      String(LIMITS.extractedContentMaxChars),
      ...pstWorkerArguments({
        mailboxName: stored.fileName,
        timeoutMs: PST_READ_TIMEOUT_MS,
        index,
      }),
    ],
    maxOutputBytes: MBOX_MESSAGE_MAX_BYTES + MESSAGE_HEADER_MAX_BYTES,
  });
  if (reply.isErr()) {
    return Result.err(reply.error);
  }
  const part = decodeEmbeddedPart(reply.value);
  return part === null ? Result.err(invalidReply()) : Result.ok(part);
};
