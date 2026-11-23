/**
 * A mailbox's messages as its list shows them: what each header states
 * (subject, sender, date, folder), the email file each message opens as,
 * and why one does not open. Read from the header alone, never the body.
 */
import { decodeWords } from "postal-mime";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";
import {
  FILE_PART_KINDS,
  filePartId,
  type FilePartUnavailableReason,
} from "@stll/api-contract/file-parts";
import type { MailboxMessage } from "@stll/api-contract/mailbox";
import { decodeDeclared } from "@stll/mojibake/declared-charset";

import { parseEmail } from "@/api/lib/files/email-to-html";
import {
  MBOX_MESSAGE_MAX_BYTES,
  type MboxMessageSpan,
} from "@/api/lib/files/mbox";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

/** The longest subject a message's file name keeps. */
const FILE_NAME_SUBJECT_MAX_CHARS = 120;

/** The longest folder a row shows, as the header states it. */
const FOLDER_MAX_CHARS = 255;

/**
 * Headers naming where a mail client filed a message, in the order they are
 * preferred: a folder (`X-Folder`, as several clients and exports write it),
 * else Gmail's labels (`X-Gmail-Labels`, as its export writes them). A
 * message without either is in the folder the mailbox itself is: clients
 * such as Thunderbird keep one folder per mailbox file, named after it.
 */
const FOLDER_HEADERS = ["x-folder", "x-gmail-labels"] as const;

/** One message of a mailbox, where it is stored and what it is. */
export type MailboxEntry = MboxMessageSpan & {
  readonly subject: string | null;
  readonly from: string | null;
  readonly date: string | null;
  readonly folder: string | null;
  /** The email file it opens as, named after its subject. */
  readonly fileName: string;
  readonly unavailable: Extract<
    FilePartUnavailableReason,
    "tooLarge" | "unreadable"
  > | null;
};

const HEADER_FIELD = /^[!-9;-~]+[ \t]*:/u;

const LINE_FEED = 0x0a;

/** The header's fields, unfolded, by lowercase name; first wins. */
const headerFields = (header: string): Map<string, string> => {
  const fields = new Map<string, string>();
  const unfolded = header.replace(/\r?\n[ \t]+/gu, " ");
  for (const line of unfolded.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon > 0 && HEADER_FIELD.test(line)) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!fields.has(name)) {
        fields.set(name, line.slice(colon + 1).trim());
      }
    }
  }
  return fields;
};

/** The folder a mailbox file is: its name, less a mailbox extension. */
export const mailboxFolderName = (mailboxName: string): string | null => {
  const folder = mailboxName
    .replace(/\.(?:mbox|mbx)$/iu, "")
    .trim()
    .slice(0, FOLDER_MAX_CHARS);
  return folder || null;
};

const folderOf = (fields: Map<string, string>): string | null => {
  for (const name of FOLDER_HEADERS) {
    const value = fields.get(name);
    if (value !== undefined) {
      const folder = decodeWords(value).trim().slice(0, FOLDER_MAX_CHARS);
      if (folder) {
        return folder;
      }
    }
  }
  return null;
};

/**
 * The name a message's email file takes: its subject, else the mailbox's
 * name and the message's number, always ending `.eml`.
 */
export const mailboxMessageFileName = (
  subject: string | null,
  mailboxName: string,
  index: number,
): string => {
  const shown = subject
    ?.replace(/\s+/gu, " ")
    .trim()
    .slice(0, FILE_NAME_SUBJECT_MAX_CHARS)
    .trim();
  const base =
    shown ||
    `${mailboxName.replace(/\.(?:mbox|mbx)$/iu, "") || "mailbox"}-${String(index + 1)}`;
  return sanitizeFilenamePreservingExtension(`${base}.eml`);
};

const unavailableReason = ({
  readable,
  tooLarge,
}: {
  readable: boolean;
  tooLarge: boolean;
}): MailboxEntry["unavailable"] => {
  if (!readable) {
    return "unreadable";
  }
  return tooLarge ? "tooLarge" : null;
};

const nonBlank = (value: string | null | undefined): string | null =>
  value?.trim() ? value.trim() : null;

/** A message as its list shows it, read from its header. */
export const mailboxEntry = async (
  span: MboxMessageSpan,
  mailboxName: string,
): Promise<MailboxEntry> => {
  // Raw 8-bit header values are in whatever charset the sender's program
  // wrote; the email reader gets the bytes themselves.
  const header = decodeDeclared(span.header, {
    contentType: EML_MIME_TYPE,
  }).text;
  const fields = headerFields(header);
  // A header cut at its bound is read as far as it goes.
  const source = span.headerComplete
    ? new Uint8Array(span.header)
    : Uint8Array.from([...span.header, LINE_FEED, LINE_FEED]);
  const parsed = await parseEmail(source.buffer, EML_MIME_TYPE);
  const email = parsed.isOk() ? parsed.value : null;
  const subject = nonBlank(email?.subject);
  // A message is read when it starts with a header field; one whose header
  // runs past the bound still opens, read as a whole by the email reader.
  const readable = span.length > 0 && HEADER_FIELD.test(header);
  const tooLarge = span.length > MBOX_MESSAGE_MAX_BYTES;
  return {
    ...span,
    subject,
    from: nonBlank(email?.from),
    date: nonBlank(email?.date),
    folder: folderOf(fields) ?? mailboxFolderName(mailboxName),
    fileName: mailboxMessageFileName(subject, mailboxName, span.index),
    unavailable: unavailableReason({ readable, tooLarge }),
  };
};

/** The row a message's list shows, opening as `message:N` when it can. */
export const mailboxMessageRow = (entry: MailboxEntry): MailboxMessage => ({
  fileName: entry.fileName,
  folder: entry.folder,
  sizeBytes: entry.length,
  subject: entry.subject,
  from: entry.from,
  date: entry.date,
  part:
    entry.unavailable === null
      ? {
          part: filePartId({
            kind: FILE_PART_KINDS.message,
            index: entry.index,
          }),
          fileName: entry.fileName,
          mediaType: EML_MIME_TYPE,
          sizeBytes: entry.length,
        }
      : null,
  unavailable: entry.unavailable,
});
