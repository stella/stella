import * as v from "valibot";

import { containedFileEntries, FILE_PART_MAX_INDEX } from "./file-parts";

/** The most messages a mailbox lists: one per position a part may have. */
export const MAILBOX_MAX_MESSAGES = FILE_PART_MAX_INDEX + 1;

/**
 * One message of a mailbox as its list shows it: what its header states
 * (subject, sender, date and the folder or labels the mail client wrote),
 * never its body. A message opens as an email of its own (`message:N`,
 * named after its subject) unless it is larger than one message may be or
 * its header cannot be read.
 */
export const mailboxMessageSchema = v.object({
  ...containedFileEntries,
  subject: v.nullable(v.string()),
  /** The sender as the header states it: name and address. */
  from: v.nullable(v.string()),
  /** The date as the header states it, which may not parse as a date. */
  date: v.nullable(v.string()),
});

export type MailboxMessage = v.InferOutput<typeof mailboxMessageSchema>;

/**
 * A mailbox (`.mbox`) in the order its messages are stored, at most
 * `MAILBOX_MAX_MESSAGES` of them; `truncated` says it holds more than that.
 */
export const mailboxPreviewSchema = v.object({
  messages: v.pipe(
    v.array(mailboxMessageSchema),
    v.maxLength(MAILBOX_MAX_MESSAGES),
  ),
  truncated: v.boolean(),
});

export type MailboxPreview = v.InferOutput<typeof mailboxPreviewSchema>;

/**
 * What a message's row shows under its subject, in order: its sender, its
 * date (formatted when it parses, else as the header states it) and the
 * folder or labels its mail client wrote. A missing value is left out,
 * never shown blank.
 */
export const mailboxMessageDetails = (
  { date, folder, from }: Pick<MailboxMessage, "date" | "folder" | "from">,
  formatDate: (date: Date) => string,
): string[] => {
  const parsed = date === null ? null : new Date(date);
  const shownDate =
    parsed === null || Number.isNaN(parsed.getTime())
      ? date
      : formatDate(parsed);
  return [from, shownDate, folder].flatMap((value) =>
    value === null || value.trim() === "" ? [] : [value],
  );
};
