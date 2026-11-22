import type { EmailTextAttachmentCharset } from "@stll/api-contract";
import {
  FILE_PART_TEXT_PREVIEW_MAX_BYTES,
  isFilePartTextMediaType,
} from "@stll/api-contract/file-parts";
import { decodeDeclared } from "@stll/mojibake/declared-charset";

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

export const filePartPreviewKind = (mediaType: string): FilePartPreviewKind => {
  const normalized = essence(mediaType);
  if (normalized === "application/pdf") {
    return FILE_PART_PREVIEW_KIND.pdf;
  }
  if (isFilePartTextMediaType(normalized)) {
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

/**
 * A text part's preview: its first bytes decoded by `decodeDeclared`, in the
 * charset their byte-order mark or the container (an email) declares, else
 * in the one they were most likely saved in.
 * The part link delivers a long text part cut one byte past the preview
 * (`filePartInlineBytes`), which is how a cut part is told from a whole one.
 */
export const decodeFilePartText = ({
  buffer,
  charset,
}: {
  buffer: ArrayBuffer;
  charset: EmailTextAttachmentCharset | null;
}): { text: string; truncated: boolean } => {
  const bytes = new Uint8Array(buffer);
  const truncated = bytes.byteLength > FILE_PART_TEXT_PREVIEW_MAX_BYTES;
  const shown = truncated
    ? bytes.subarray(0, FILE_PART_TEXT_PREVIEW_MAX_BYTES)
    : bytes;
  const { text } = decodeDeclared(shown, {
    contentType: charset === null ? null : `text/plain; charset=${charset}`,
  });
  return { text, truncated };
};
