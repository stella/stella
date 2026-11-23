/**
 * The extraction worker's Outlook mailbox modes: the stored mailbox streams
 * in on the worker's input, is written to a private temporary file, and is
 * read from it at an offset; the reply is its list (JSON), one message as an
 * email (an embedded part reply) or its text.
 */
import { panic } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import type { MailboxPreview } from "@stll/api-contract/mailbox";
import { Temporal } from "@stll/time";

import {
  PST_WORKER_EXIT,
  PST_WORKER_MODE,
} from "@/api/lib/files/archive-preview-protocol";
import { encodeEmbeddedPart } from "@/api/lib/files/embedded-part-protocol";
import { mailboxMessageRow } from "@/api/lib/files/mailbox-messages";
import {
  PST_OPERATION_MAX_MS,
  readPstEntries,
  readPstMessage,
  readPstText,
  withPstFile,
} from "@/api/lib/files/pst-mailbox";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { writeWorkerStdout } from "@/api/lib/subprocess";

export type PstWorkerMode =
  (typeof PST_WORKER_MODE)[keyof typeof PST_WORKER_MODE];

export const isPstWorkerMode = (mode: string): mode is PstWorkerMode =>
  Object.values(PST_WORKER_MODE).some((candidate) => candidate === mode);

/** Time kept back from the worker's timeout to answer before it is killed. */
const REPLY_MARGIN_MS = 3000;

export type PstWorkerRequest = {
  readonly mode: PstWorkerMode;
  readonly maxChars: number;
  readonly mailboxName: string;
  /** The worker's own timeout, which the reading must end within. */
  readonly timeoutMs: number;
  /** The message's position, for `message`. */
  readonly index: number | null;
};

/** The request `argv` (mode, budget, name, timeout, index) names. */
export const readPstWorkerRequest = (
  mode: PstWorkerMode,
  maxChars: number,
  [mailboxName = "", timeout, index]: readonly (string | undefined)[],
): PstWorkerRequest | null => {
  const timeoutMs = parseIntegerToken(timeout, { sign: "unsigned" });
  const position =
    index === undefined ? null : parseIntegerToken(index, { sign: "unsigned" });
  if (timeoutMs.isErr() || position?.isErr() === true) {
    return null;
  }
  return {
    mode,
    maxChars,
    mailboxName,
    timeoutMs: timeoutMs.value,
    index: position?.isOk() === true ? position.value : null,
  };
};

/** Answers `request` from the mailbox on `chunks`; the worker's exit code. */
export const runPstWorker = async (
  request: PstWorkerRequest,
  chunks: AsyncIterable<Uint8Array>,
): Promise<number> => {
  const started = Temporal.Now.instant().epochMilliseconds;
  const deadline = Math.min(
    started + request.timeoutMs - REPLY_MARGIN_MS,
    started + PST_OPERATION_MAX_MS,
  );
  const { mailboxName } = request;
  const replied = await withPstFile(
    chunks,
    FILE_SIZE_LIMIT_BYTES.document,
    async (open): Promise<number> => {
      switch (request.mode) {
        case PST_WORKER_MODE.list: {
          const listed = readPstEntries(open(deadline), mailboxName);
          if (listed.isErr()) {
            return PST_WORKER_EXIT.unreadable;
          }
          const preview: MailboxPreview = {
            messages: listed.value.entries.map(mailboxMessageRow),
            truncated: listed.value.truncated,
          };
          await writeWorkerStdout(JSON.stringify(preview));
          return 0;
        }
        case PST_WORKER_MODE.message: {
          if (request.index === null) {
            return PST_WORKER_EXIT.noMessage;
          }
          const read = readPstMessage(
            open(deadline),
            request.index,
            mailboxName,
          );
          if (read.isErr()) {
            const { error } = read;
            if ("_tag" in error) {
              return PST_WORKER_EXIT.unreadable;
            }
            return error.type === "noMessage"
              ? PST_WORKER_EXIT.noMessage
              : PST_WORKER_EXIT.tooLarge;
          }
          await writeWorkerStdout(
            encodeEmbeddedPart({
              fileName: read.value.entry.fileName,
              mimeType: EML_MIME_TYPE,
              bytes: read.value.email,
            }),
          );
          return 0;
        }
        case PST_WORKER_MODE.text: {
          const text = await readPstText({
            open,
            maxChars: request.maxChars,
            mailboxName,
            // Text reads every message: it may take the worker's time.
            deadline: started + request.timeoutMs - REPLY_MARGIN_MS,
          });
          if (text.isErr()) {
            return PST_WORKER_EXIT.unreadable;
          }
          await writeWorkerStdout(text.value);
          return 0;
        }
        default:
          request.mode satisfies never;
          return panic("Unhandled mailbox worker mode");
      }
    },
  );
  return replied.isErr() ? PST_WORKER_EXIT.unreadable : replied.value;
};
