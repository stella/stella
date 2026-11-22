import type { EmailTextAttachmentCharset } from "@stll/api-contract";
import { decodeDeclared } from "@stll/mojibake/declared-charset";

export const EMAIL_ATTACHMENT_PREVIEW_KIND = {
  image: "image",
  pdf: "pdf",
  text: "text",
  unsupported: "unsupported",
} as const;

export type EmailAttachmentPreviewKind =
  (typeof EMAIL_ATTACHMENT_PREVIEW_KIND)[keyof typeof EMAIL_ATTACHMENT_PREVIEW_KIND];

export const getEmailAttachmentPreviewId = ({
  attachmentId,
  fieldId,
  workspaceId,
}: {
  attachmentId: string;
  fieldId: string;
  workspaceId: string;
}): string => `email-attachment:${workspaceId}:${fieldId}:${attachmentId}`;

export const getEmailAttachmentPreviewKind = (
  mimeType: string | null,
): EmailAttachmentPreviewKind => {
  const normalized = mimeType?.split(";").at(0)?.trim().toLowerCase() ?? "";
  if (normalized === "application/pdf") {
    return EMAIL_ATTACHMENT_PREVIEW_KIND.pdf;
  }
  if (normalized === "text/plain") {
    return EMAIL_ATTACHMENT_PREVIEW_KIND.text;
  }
  if (/^image\/(?:png|jpe?g|gif|webp)$/u.test(normalized)) {
    return EMAIL_ATTACHMENT_PREVIEW_KIND.image;
  }
  return EMAIL_ATTACHMENT_PREVIEW_KIND.unsupported;
};

/**
 * An attachment's text in the charset its byte-order mark or its MIME part
 * declares, else in the one it was most likely saved in.
 */
export const decodeEmailTextAttachment = ({
  buffer,
  charset,
}: {
  buffer: ArrayBuffer;
  charset: EmailTextAttachmentCharset | null;
}): string =>
  decodeDeclared(new Uint8Array(buffer), {
    contentType: charset === null ? null : `text/plain; charset=${charset}`,
  }).text;

export const getEmailAttachmentActivationId = ({
  id,
  previewable,
}: {
  id: string;
  previewable: boolean;
}): string | null => (previewable ? id : null);
