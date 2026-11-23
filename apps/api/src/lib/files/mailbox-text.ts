/**
 * A mailbox's text for search, chat, workflows and agents: each message's
 * sender, recipients, date and subject, its body and its attachments'
 * names, in the mailbox's order, read one message at a time from a stream of
 * the file's bytes and within one character budget.
 */
import { Result } from "better-result";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import { MAILBOX_MAX_MESSAGES } from "@stll/api-contract/mailbox";

import { parsedEmailToText, parseEmail } from "@/api/lib/files/email-to-html";
import {
  type MailboxEntry,
  mailboxEntry,
} from "@/api/lib/files/mailbox-messages";
import {
  type MboxMessage,
  mboxMessageBytes,
  type MboxParseError,
  MboxScanner,
} from "@/api/lib/files/mbox";

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const isInlineImage = ({
  contentId,
  mimeType,
}: {
  contentId: string | null;
  mimeType: string | null;
}) => contentId !== null && (mimeType ?? "").startsWith("image/");

const headerLines = (entry: MailboxEntry) =>
  [
    ["From", entry.from],
    ["Date", entry.date],
    ["Subject", entry.subject],
  ].flatMap(([label, value]) => (value ? [`${label}: ${value}`] : []));

/** One message's text: its header, body and attachments' names. */
const messageText = async (
  entry: MailboxEntry,
  stored: Uint8Array | null,
): Promise<string> => {
  const heading = `Message ${String(entry.index + 1)}${
    entry.folder === null ? "" : ` (folder: ${entry.folder})`
  }`;
  if (entry.unavailable === "tooLarge" || stored === null) {
    return [
      heading,
      ...headerLines(entry),
      "The message is too large to read.",
    ].join("\n");
  }
  if (entry.unavailable === "unreadable") {
    return `${heading}\nThe message could not be read.`;
  }
  const parsed = await parseEmail(
    toArrayBuffer(mboxMessageBytes(stored, entry.bounded)),
    EML_MIME_TYPE,
  );
  if (parsed.isErr()) {
    return [
      heading,
      ...headerLines(entry),
      "The message could not be read.",
    ].join("\n");
  }
  const attachments = parsed.value.attachments
    .filter((attachment) => !isInlineImage(attachment))
    .map(({ fileName }) => fileName?.trim() || "unnamed");
  return [
    heading,
    parsedEmailToText(parsed.value),
    ...(attachments.length === 0
      ? []
      : [`Attachments: ${attachments.join(", ")}`]),
  ].join("\n");
};

/**
 * The text of the mailbox `chunks` stream, cut at `maxChars`. Every chunk is
 * consumed, so a writer streaming the file in is never cut off; once the
 * budget is spent, the rest is only scanned.
 */
export const readMailboxText = async ({
  chunks,
  maxChars,
  mailboxName,
}: {
  chunks: AsyncIterable<Uint8Array>;
  maxChars: number;
  mailboxName: string;
}): Promise<Result<string, MboxParseError>> => {
  const blocks: string[] = ["Mailbox."];
  let length = blocks[0]?.length ?? 0;
  const ready: MboxMessage[] = [];
  const scanner = new MboxScanner((message) => {
    if (length < maxChars) {
      ready.push(message);
    }
  }, true);
  const take = async () => {
    for (let message = ready.shift(); message; message = ready.shift()) {
      if (length >= maxChars) {
        ready.length = 0;
        return;
      }
      const entry = await mailboxEntry(message, mailboxName);
      const block = await messageText(entry, message.stored);
      blocks.push(block);
      length += block.length + 2;
    }
  };
  for await (const chunk of chunks) {
    if (!scanner.done) {
      scanner.push(chunk);
      await take();
    }
  }
  scanner.finish();
  await take();
  if (scanner.failure !== null) {
    return Result.err(scanner.failure);
  }
  if (scanner.truncated) {
    blocks.push(
      `Only the first ${String(MAILBOX_MAX_MESSAGES)} messages are read.`,
    );
  }
  return Result.ok(blocks.join("\n\n").slice(0, maxChars));
};

/** Chunks a mailbox held in memory is read in, so messages go one by one. */
const IN_MEMORY_CHUNK_BYTES = 1024 * 1024;

/** A mailbox held in memory, read as a stream of its bytes would be. */
export const readMailboxBytesText = async (options: {
  bytes: Uint8Array;
  maxChars: number;
  mailboxName: string;
}) =>
  await readMailboxText({
    ...options,
    chunks: (async function* () {
      for (
        let start = 0;
        start < options.bytes.byteLength;
        start += IN_MEMORY_CHUNK_BYTES
      ) {
        await Promise.resolve();
        yield options.bytes.subarray(start, start + IN_MEMORY_CHUNK_BYTES);
      }
    })(),
  });
