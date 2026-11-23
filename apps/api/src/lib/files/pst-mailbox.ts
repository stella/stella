/**
 * An Outlook mailbox (`.pst`) read by `@stll/pst-reader` from a file it reads
 * at an offset: its list of messages, one message as the email it opens
 * as, and its text. Run in the extraction worker: reading is synchronous.
 * The stored mailbox reaches the worker as a stream, written to a private
 * temporary file that is removed when the read ends, so the mailbox is never
 * held in memory; one inside another file is read from its bytes.
 */
import { panic, Result, TaggedError } from "better-result";
import { readSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FilePartUnavailableReason } from "@stll/api-contract/file-parts";
import { MAILBOX_MAX_MESSAGES } from "@stll/api-contract/mailbox";
import { declareFingerprintFields } from "@stll/errors";
import {
  createPstReader,
  type PstHostFile,
  pstInteger,
  type PstListing,
  type PstMailbox as PstReaderMailbox,
  type PstReader,
  type PstReaderLimits,
  type PstRefusal,
} from "@stll/pst-reader";
import { Temporal } from "@stll/time";

import {
  mailboxFolderName,
  type MailboxListedMessage,
  mailboxMessageFileName,
} from "@/api/lib/files/mailbox-messages";
import {
  MAILBOX_TEXT_HEADING,
  MAILBOX_TEXT_TRUNCATED,
  mailboxMessageText,
} from "@/api/lib/files/mailbox-text";
import { MBOX_MESSAGE_MAX_BYTES } from "@/api/lib/files/mbox";
import {
  PST_PROPERTY,
  pstCodePage,
  pstMailboxText,
  pstMessageDate,
  pstMessageEmail,
  pstSender,
  pstSubject,
  pstText,
  rfc5322Date,
} from "@/api/lib/files/pst-message-mime";

export class PstReadError extends TaggedError("PstReadError")<{
  message: string;
  reason: "unreadable" | "stopped";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/** What reading one stored mailbox may take ([`PstReaderLimits`]). */
export const PST_MAILBOX_LIMITS = {
  // One message per position a part may have, as a `.mbox` lists.
  maxMessages: MAILBOX_MAX_MESSAGES,
  // As large as one message of a `.mbox` may be.
  maxMessageBytes: MBOX_MESSAGE_MAX_BYTES,
  maxWalkBytes: 128 * 1024 * 1024,
  // A message's blocks, their index pages and its attachments' trees.
  maxMessageReadBytes: 3 * MBOX_MESSAGE_MAX_BYTES,
  maxReads: 1_000_000,
  maxFolders: 2000,
  maxFolderDepth: 32,
  maxRecipients: 500,
  // As many as an email's preview lists.
  maxAttachments: 100,
} as const satisfies PstReaderLimits;

/** How long one read of a mailbox (its list, one message) may take. */
export const PST_OPERATION_MAX_MS = 20_000;

const reader: { current: PstReader | null } = { current: null };

const pstReader = (): PstReader => (reader.current ??= createPstReader());

/** Bytes held in memory, such as a mailbox inside another file. */
export const pstBytesFile = (
  bytes: Uint8Array,
  deadline: number,
): PstHostFile => ({
  size: bytes.byteLength,
  readAt: (offset, buffer) => {
    if (Temporal.Now.instant().epochMilliseconds > deadline) {
      return -1;
    }
    const read = bytes.subarray(offset, offset + buffer.byteLength);
    buffer.set(read);
    return read.byteLength;
  },
});

/** A file on disk, read at an offset; -1 once the deadline has passed. */
const pstDiskFile = (
  descriptor: number,
  size: number,
  deadline: number,
): PstHostFile => ({
  size,
  readAt: (offset, buffer) => {
    if (Temporal.Now.instant().epochMilliseconds > deadline) {
      return -1;
    }
    // The reader stops on -1: a read that fails ends the operation, never
    // the worker.
    return Result.try(() =>
      readSync(descriptor, buffer, 0, buffer.byteLength, offset),
    ).unwrapOr(-1);
  },
});

/**
 * Writes `chunks` (the stored mailbox) to a private temporary file, at most
 * `maxBytes` of them, and runs `read` on it. The file's name is removed as
 * soon as it is opened, so its open descriptor is its only reference: the
 * system frees it when the worker ends, however it ends (a timeout, an abort
 * or a kill on its memory bound), and nothing is left on disk.
 */
export const withPstFile = async <T>(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
  read: (open: (deadline: number) => PstHostFile) => Promise<T>,
): Promise<Result<T, PstReadError>> => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-pst-"));
  const handle = await open(
    path.join(directory, "mailbox.pst"),
    "wx+",
    0o600,
  ).finally(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  try {
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        return Result.err(
          new PstReadError({
            message: "The mailbox is larger than a stored file may be",
            reason: "unreadable",
          }),
        );
      }
      await handle.write(chunk);
    }
    return Result.ok(
      await read((deadline) => pstDiskFile(handle.fd, size, deadline)),
    );
  } finally {
    await handle.close();
  }
};

/** One message of a PST's list: what its folder's table states. */
export type PstMailboxEntry = MailboxListedMessage;

/** The mailbox file's own name is the folder of a message filed at its top. */
const folderPath = (
  listing: PstListing,
  folder: number,
  mailboxName: string,
): string | null => {
  const names: string[] = [];
  for (
    let at = listing.folders[folder];
    at !== undefined && at.depth > 0;
    at = at.parent === null ? undefined : listing.folders[at.parent]
  ) {
    const name = pstText(at.properties, PST_PROPERTY.displayName);
    if (name !== null) {
      names.unshift(name);
    }
  }
  return names.length > 0
    ? names.join("/").slice(0, 255)
    : mailboxFolderName(mailboxName);
};

/** A message's list row, from its folder's contents table. */
const listedEntry = (
  listing: PstListing,
  index: number,
  mailboxName: string,
): PstMailboxEntry => {
  const message = listing.messages[index] ?? panic("No such listed message");
  const { properties } = message;
  const codePage = pstCodePage(properties);
  const subject = pstSubject(properties, codePage);
  const date = pstMessageDate(properties);
  const size = Math.max(
    0,
    pstInteger(properties, PST_PROPERTY.messageSize) ?? 0,
  );
  const unavailable: Extract<FilePartUnavailableReason, "tooLarge"> | null =
    size > MBOX_MESSAGE_MAX_BYTES ? "tooLarge" : null;
  return {
    index,
    length: size,
    subject,
    from: pstMailboxText(pstSender(properties, codePage)),
    date: date === null ? null : rfc5322Date(date),
    folder: folderPath(listing, message.folder, mailboxName),
    fileName: mailboxMessageFileName(subject, mailboxName, index),
    unavailable,
  };
};

const stopped = (refusal: PstRefusal) =>
  new PstReadError({
    message: `The mailbox reader refused the mailbox: ${refusal.type}`,
    reason: refusal.type === "exhausted" ? "stopped" : "unreadable",
  });

const openMailbox = (
  file: PstHostFile,
): Result<PstReaderMailbox, PstReadError> => {
  const opened = pstReader().open(file, PST_MAILBOX_LIMITS);
  return opened.type === "read"
    ? Result.ok(opened.value)
    : Result.err(stopped(opened));
};

/** The mailbox's messages as its list shows them. */
export const readPstEntries = (
  file: PstHostFile,
  mailboxName: string,
): Result<{ entries: PstMailboxEntry[]; truncated: boolean }, PstReadError> => {
  const mailbox = openMailbox(file);
  if (mailbox.isErr()) {
    return Result.err(mailbox.error);
  }
  try {
    const listed = mailbox.value.list();
    if (listed.type !== "read") {
      return Result.err(stopped(listed));
    }
    const listing = listed.value;
    return Result.ok({
      entries: listing.messages.map((_, index) =>
        listedEntry(listing, index, mailboxName),
      ),
      truncated: listing.truncated,
    });
  } finally {
    mailbox.value.close();
  }
};

/** Why a message of a mailbox is not read. */
export type PstMessageRefusal =
  { readonly type: "noMessage" } | { readonly type: "tooLarge" };

const emailOf = (
  mailbox: PstReaderMailbox,
  index: number,
): Result<Uint8Array, PstMessageRefusal | PstReadError> => {
  const read = mailbox.message(index);
  if (read.type === "no-message") {
    return Result.err({ type: "noMessage" });
  }
  if (read.type === "too-large") {
    return Result.err({ type: "tooLarge" });
  }
  if (read.type !== "read") {
    return Result.err(stopped(read));
  }
  const email = pstMessageEmail(read.value);
  return email.byteLength > MBOX_MESSAGE_MAX_BYTES
    ? Result.err({ type: "tooLarge" })
    : Result.ok(email);
};

/** One message of the mailbox, as the email it opens as, and its row. */
export const readPstMessage = (
  file: PstHostFile,
  index: number,
  mailboxName: string,
): Result<
  { entry: PstMailboxEntry; email: Uint8Array },
  PstMessageRefusal | PstReadError
> => {
  const mailbox = openMailbox(file);
  if (mailbox.isErr()) {
    return Result.err(mailbox.error);
  }
  try {
    const listed = mailbox.value.list();
    if (listed.type !== "read") {
      return Result.err(stopped(listed));
    }
    if (index >= listed.value.messages.length) {
      return Result.err({ type: "noMessage" });
    }
    const entry = listedEntry(listed.value, index, mailboxName);
    if (entry.unavailable !== null) {
      return Result.err({ type: "tooLarge" });
    }
    return emailOf(mailbox.value, index).map((email) => ({ entry, email }));
  } finally {
    mailbox.value.close();
  }
};

/** A message as reading it gives it: its row, and its email or why not. */
type PstReadMessage = {
  readonly entry: PstMailboxEntry;
  /** The email; null when its row is over the bound, so it is not read. */
  readonly email: Result<Uint8Array, PstMessageRefusal | PstReadError> | null;
};

/**
 * Every listed message of the mailbox, in order, read one at a time and
 * handed to `visit`, which answers whether to go on. A message the reader
 * is stopped on (its deadline) ends the reading before it is handed on.
 */
const visitPstMessages = async (
  file: PstHostFile,
  mailboxName: string,
  visit: (message: PstReadMessage) => Promise<boolean>,
): Promise<Result<{ truncated: boolean }, PstReadError>> => {
  const mailbox = openMailbox(file);
  if (mailbox.isErr()) {
    return Result.err(mailbox.error);
  }
  try {
    const listed = mailbox.value.list();
    if (listed.type !== "read") {
      return Result.err(stopped(listed));
    }
    const listing = listed.value;
    for (const [index] of listing.messages.entries()) {
      const entry = listedEntry(listing, index, mailboxName);
      const email =
        entry.unavailable === null ? emailOf(mailbox.value, index) : null;
      if (
        email?.isErr() === true &&
        "_tag" in email.error &&
        email.error.reason === "stopped"
      ) {
        break;
      }
      if (!(await visit({ entry, email }))) {
        break;
      }
    }
    return Result.ok({ truncated: listing.truncated });
  } finally {
    mailbox.value.close();
  }
};

/** A message's row as its text and list give it once read. */
const readMessageEntry = ({ entry, email }: PstReadMessage): PstMailboxEntry =>
  email?.isErr() === true
    ? {
        ...entry,
        unavailable:
          "_tag" in email.error || email.error.type === "noMessage"
            ? "unreadable"
            : "tooLarge",
      }
    : entry;

/**
 * The mailbox's text for search, chat, workflows and agents: each message's
 * header, body and attachments' names, in the list's order, one message at
 * a time, cut at `maxChars`. Reading stops at the deadline with the text
 * read so far.
 */
export const readPstText = async ({
  open: openFile,
  maxChars,
  mailboxName,
  deadline,
}: {
  open: (deadline: number) => PstHostFile;
  maxChars: number;
  mailboxName: string;
  deadline: number;
}): Promise<Result<string, PstReadError>> => {
  const blocks: string[] = [MAILBOX_TEXT_HEADING];
  let length = MAILBOX_TEXT_HEADING.length;
  const read = await visitPstMessages(
    openFile(deadline),
    mailboxName,
    async (message) => {
      const block = await mailboxMessageText(
        readMessageEntry(message),
        message.email?.isOk() === true ? message.email.value : null,
      );
      blocks.push(block);
      length += block.length + 2;
      return (
        length < maxChars &&
        Temporal.Now.instant().epochMilliseconds <= deadline
      );
    },
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  if (read.value.truncated) {
    blocks.push(MAILBOX_TEXT_TRUNCATED);
  }
  return Result.ok(blocks.join("\n\n").slice(0, maxChars));
};
