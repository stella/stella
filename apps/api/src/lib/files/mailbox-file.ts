/**
 * A stored mailbox, read without ever holding it whole: its list is built by
 * streaming the stored object through the mailbox reader (one network chunk
 * in memory, plus at most the message being read), and one message is read
 * by a range GET of exactly its bytes.
 */
import { Result } from "better-result";

import type {
  MailboxMessage,
  MailboxPreview,
} from "@stll/api-contract/mailbox";

import type { FileKey } from "@/api/lib/file-key";
import {
  type MailboxEntry,
  mailboxEntry,
  mailboxMessageRow,
} from "@/api/lib/files/mailbox-messages";
import { openStoredMailbox } from "@/api/lib/files/mailbox-stream-text";
import {
  type MboxMessage,
  mboxMessageBytes,
  type MboxParseError,
  MboxScanner,
} from "@/api/lib/files/mbox";
import { LIMITS } from "@/api/lib/limits";
import { readDocumentS3Range } from "@/api/lib/s3";

/** How long one pass over a stored mailbox may take. */
export const MAILBOX_READ_TIMEOUT_MS = LIMITS.extractionTimeoutMs;

type StoredMailbox = {
  readonly key: FileKey;
  /** The mailbox's file name, which a message without a subject takes. */
  readonly fileName: string;
  readonly signal: AbortSignal;
};

/**
 * Streams the stored mailbox through the reader, handing each message to
 * `onMessage` as it is found; `onMessage` answers whether to stop there.
 */
const scanStoredMailbox = async (
  { key, signal }: Pick<StoredMailbox, "key" | "signal">,
  onMessage: (message: MboxMessage) => Promise<boolean>,
): Promise<Result<{ truncated: boolean }, MboxParseError>> => {
  const opened = await openStoredMailbox({ key, signal });
  const found: MboxMessage[] = [];
  const scanner = new MboxScanner((message) => found.push(message));
  let stopped = false;
  const take = async () => {
    for (let message = found.shift(); message; message = found.shift()) {
      if (await onMessage(message)) {
        stopped = true;
        return;
      }
    }
  };
  for await (const chunk of opened.chunks) {
    scanner.push(chunk);
    await take();
    // Leaving the loop cancels the rest of the object's body.
    if (stopped || scanner.done) {
      break;
    }
  }
  if (!stopped) {
    scanner.finish();
    await take();
  }
  return scanner.failure === null
    ? Result.ok({ truncated: scanner.truncated })
    : Result.err(scanner.failure);
};

/** A stored mailbox's messages as its list shows them. */
export const readStoredMailboxPreview = async (
  mailbox: StoredMailbox,
): Promise<Result<MailboxPreview, MboxParseError>> => {
  const messages: MailboxMessage[] = [];
  const scanned = await scanStoredMailbox(mailbox, async (message) => {
    messages.push(
      mailboxMessageRow(await mailboxEntry(message, mailbox.fileName)),
    );
    return false;
  });
  return scanned.map(({ truncated }) => ({ messages, truncated }));
};

/** Why a message of a stored mailbox is not read. */
export type StoredMessageRefusal =
  | { readonly type: "noMessage" }
  | { readonly type: "unavailable"; readonly entry: MailboxEntry };

/** One message of a stored mailbox, as the email it opens as. */
export type StoredMailboxMessage = {
  readonly entry: MailboxEntry;
  readonly bytes: Uint8Array;
};

/**
 * One message of a stored mailbox: the mailbox is streamed only as far as
 * that message, then the message alone is read by its range.
 */
export const readStoredMailboxMessage = async (
  mailbox: StoredMailbox & { readonly index: number },
): Promise<
  Result<StoredMailboxMessage, MboxParseError | StoredMessageRefusal>
> => {
  const hit: { entry: MailboxEntry | null } = { entry: null };
  const scanned = await scanStoredMailbox(mailbox, async (message) => {
    if (message.index !== mailbox.index) {
      return false;
    }
    hit.entry = await mailboxEntry(message, mailbox.fileName);
    return true;
  });
  if (scanned.isErr()) {
    return Result.err(scanned.error);
  }
  const found = hit.entry;
  if (found === null) {
    return Result.err({ type: "noMessage" });
  }
  if (found.unavailable !== null) {
    return Result.err({ type: "unavailable", entry: found });
  }
  const stored = await readDocumentS3Range({
    key: mailbox.key,
    offset: found.offset,
    length: found.length,
    signal: mailbox.signal,
  });
  return Result.ok({
    entry: found,
    bytes: mboxMessageBytes(stored, found.bounded),
  });
};
