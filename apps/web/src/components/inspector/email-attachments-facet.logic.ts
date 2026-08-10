import {
  EMAIL_TEXT_ATTACHMENT_CHARSET,
  type EmailTextAttachmentCharset,
} from "@stll/api-contract";

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
): EmailTextAttachmentCharset | null => {
  if (bytes.at(0) === 0xef && bytes.at(1) === 0xbb && bytes.at(2) === 0xbf) {
    return EMAIL_TEXT_ATTACHMENT_CHARSET.utf8;
  }
  if (bytes.at(0) === 0xff && bytes.at(1) === 0xfe) {
    return EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Le;
  }
  if (bytes.at(0) === 0xfe && bytes.at(1) === 0xff) {
    return EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Be;
  }
  return null;
};

const decodeUtf16Be = (bytes: Uint8Array): string => {
  const completeByteLength = bytes.byteLength - (bytes.byteLength % 2);
  const littleEndianBytes = new Uint8Array(completeByteLength);
  for (let index = 0; index < completeByteLength; index += 2) {
    littleEndianBytes[index] = bytes[index + 1] ?? 0;
    littleEndianBytes[index + 1] = bytes[index] ?? 0;
  }
  return new TextDecoder("utf-16").decode(littleEndianBytes);
};

export const decodeEmailTextAttachment = ({
  buffer,
  charset,
}: {
  buffer: ArrayBuffer;
  charset: EmailTextAttachmentCharset | null;
}): string => {
  const bytes = new Uint8Array(buffer);
  if (charset === EMAIL_TEXT_ATTACHMENT_CHARSET.utf16) {
    const byteOrder = getByteOrderMarkEncoding(bytes);
    return byteOrder === EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Be
      ? decodeUtf16Be(bytes)
      : new TextDecoder("utf-16").decode(bytes);
  }
  const encoding =
    charset ??
    getByteOrderMarkEncoding(bytes) ??
    EMAIL_TEXT_ATTACHMENT_CHARSET.utf8;
  switch (encoding) {
    case EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Le:
      return new TextDecoder("utf-16").decode(bytes);
    case EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Be:
      return decodeUtf16Be(bytes);
    default:
      return new TextDecoder(encoding).decode(bytes);
  }
};

export const getEmailAttachmentActivationId = ({
  id,
  previewable,
}: {
  id: string;
  previewable: boolean;
}): string | null => (previewable ? id : null);
