import {
  EMAIL_TEXT_ATTACHMENT_CHARSET,
  type EmailTextAttachmentCharset,
  MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES,
} from "@stll/api-contract";

/**
 * How a part of a file (an email's attachment, a data-box file, a signed
 * container's document, an invoice's attachment) previews in place. Only
 * passive renderings: a PDF in the PDF viewer, a raster image, text as text.
 * Anything else is listed with its type and offered for download and saving.
 */
export const FILE_PART_PREVIEW_KIND = {
  image: "image",
  pdf: "pdf",
  text: "text",
  none: "none",
} as const;

export type FilePartPreviewKind =
  (typeof FILE_PART_PREVIEW_KIND)[keyof typeof FILE_PART_PREVIEW_KIND];

const essence = (mediaType: string) =>
  (mediaType.split(";").at(0) ?? "").trim().toLowerCase();

/** Text shown as text, never rendered: plain, CSV and XML. */
const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/xml",
  "application/xml",
]);

export const filePartPreviewKind = (mediaType: string): FilePartPreviewKind => {
  const normalized = essence(mediaType);
  if (normalized === "application/pdf") {
    return FILE_PART_PREVIEW_KIND.pdf;
  }
  if (TEXT_MEDIA_TYPES.has(normalized)) {
    return FILE_PART_PREVIEW_KIND.text;
  }
  if (/^image\/(?:png|jpe?g|gif|webp)$/u.test(normalized)) {
    return FILE_PART_PREVIEW_KIND.image;
  }
  return FILE_PART_PREVIEW_KIND.none;
};

/**
 * What a person can do with a part: every part opens in place (a preview, or
 * its type and size where none exists), downloads, and saves to a matter
 * when they may create documents.
 */
export const filePartActions = ({
  canSave,
  mediaType,
}: {
  canSave: boolean;
  mediaType: string;
}) => ({
  preview: filePartPreviewKind(mediaType) !== FILE_PART_PREVIEW_KIND.none,
  download: true,
  save: canSave,
});

/** The identity a part's preview keeps its zoom and PDF cache under. */
export const filePartViewId = ({
  fieldId,
  part,
  workspaceId,
}: {
  fieldId: string;
  part: string;
  workspaceId: string;
}): string => `file-part:${workspaceId}:${fieldId}:${part}`;

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

const decodeText = (
  bytes: Uint8Array,
  charset: EmailTextAttachmentCharset | null,
): string => {
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
  if (encoding === EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Be) {
    return decodeUtf16Be(bytes);
  }
  return new TextDecoder(encoding).decode(bytes);
};

/**
 * A text part's preview: its first bytes decoded with the charset the
 * container declares (an email's), else its byte-order mark, else UTF-8.
 */
export const decodeFilePartText = ({
  buffer,
  charset,
}: {
  buffer: ArrayBuffer;
  charset: EmailTextAttachmentCharset | null;
}): { text: string; truncated: boolean } => {
  const bytes = new Uint8Array(buffer);
  const truncated = bytes.byteLength > MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES;
  const shown = truncated
    ? bytes.subarray(0, MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES)
    : bytes;
  return { text: decodeText(shown, charset), truncated };
};
