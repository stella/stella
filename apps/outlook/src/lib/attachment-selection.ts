import type { OutlookAttachment } from "@/types";

export const selectedOrdinaryAttachmentIds = (
  attachments: readonly OutlookAttachment[],
  excludedAttachmentIds: ReadonlySet<string>,
): Set<string> =>
  new Set(
    attachments
      .filter(
        (attachment) =>
          !attachment.isInline && !excludedAttachmentIds.has(attachment.id),
      )
      .map((attachment) => attachment.id),
  );

export const attachmentsForIngestion = (
  attachments: readonly OutlookAttachment[],
  excludedAttachmentIds: ReadonlySet<string> | null,
): OutlookAttachment[] =>
  attachments.filter(
    (attachment) =>
      attachment.isInline ||
      excludedAttachmentIds === null ||
      !excludedAttachmentIds.has(attachment.id),
  );
