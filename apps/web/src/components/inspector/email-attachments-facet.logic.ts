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

const getByteOrderMarkEncoding = (
  bytes: Uint8Array,
): "utf-16be" | "utf-16le" | "utf-8" | null => {
  if (bytes.at(0) === 0xef && bytes.at(1) === 0xbb && bytes.at(2) === 0xbf) {
    return "utf-8";
  }
  if (bytes.at(0) === 0xff && bytes.at(1) === 0xfe) {
    return "utf-16le";
  }
  if (bytes.at(0) === 0xfe && bytes.at(1) === 0xff) {
    return "utf-16be";
  }
  return null;
};

export const decodeEmailTextAttachment = ({
  buffer,
  charset,
}: {
  buffer: ArrayBuffer;
  charset: string | null;
}): string => {
  const bytes = new Uint8Array(buffer);
  const encoding = charset ?? getByteOrderMarkEncoding(bytes) ?? "utf-8";
  return new TextDecoder(encoding).decode(bytes);
};

export const getEmailAttachmentActivationId = ({
  id,
  previewable,
}: {
  id: string;
  previewable: boolean;
}): string | null => (previewable ? id : null);
