import {
  EMAIL_TEXT_ATTACHMENT_CHARSET,
  type EmailTextAttachmentCharset,
} from "@stll/api-contract";
import { opensToFilesInside } from "@stll/api-contract/file-part-containers";
import {
  type ContainedFile,
  FILE_PART_TEXT_PREVIEW_MAX_BYTES,
  type FilePartDescriptor,
  type FilePartUnavailableReason,
  isFilePartConvertedMediaType,
  isFilePartTextMediaType,
} from "@stll/api-contract/file-parts";
import { decodeDeclared } from "@stll/mojibake/declared-charset";

import type { TranslationKey } from "@/i18n/types";
import { DOCX_MIME, getNativeOfficeViewerFormat } from "@/lib/consts";

/**
 * How a part of a file (an email's attachment, a data-box file, a signed
 * container's document, an invoice's attachment) previews in place, the way
 * a stored file of its type does: a PDF in the PDF viewer, a Word document
 * in the read-only document view, a spreadsheet or presentation in the
 * office viewer, a document no viewer draws as the PDF the server converts
 * it to (`converted`), a raster image, text as text. Anything else is listed
 * with its type and offered for download and saving.
 */
export const FILE_PART_PREVIEW_KIND = {
  image: "image",
  pdf: "pdf",
  converted: "converted",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  text: "text",
  none: "none",
} as const;

export type FilePartPreviewKind =
  (typeof FILE_PART_PREVIEW_KIND)[keyof typeof FILE_PART_PREVIEW_KIND];

/** Kinds the PDF viewer draws, with its zoom controls. */
export const isFilePartPdfPreviewKind = (kind: FilePartPreviewKind) =>
  kind === FILE_PART_PREVIEW_KIND.pdf ||
  kind === FILE_PART_PREVIEW_KIND.converted;

const essence = (mediaType: string) =>
  (mediaType.split(";").at(0) ?? "").trim().toLowerCase();

export const filePartPreviewKind = (mediaType: string): FilePartPreviewKind => {
  const normalized = essence(mediaType);
  if (normalized === "application/pdf") {
    return FILE_PART_PREVIEW_KIND.pdf;
  }
  if (normalized === DOCX_MIME) {
    return FILE_PART_PREVIEW_KIND.docx;
  }
  const office = getNativeOfficeViewerFormat(normalized);
  if (office !== null) {
    return FILE_PART_PREVIEW_KIND[office];
  }
  if (isFilePartConvertedMediaType(normalized)) {
    return FILE_PART_PREVIEW_KIND.converted;
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
 * Whether a part that has no preview of its own opens to the files inside
 * it: it is a container (an email, an archive, a data-box message, a signed
 * file) and its own parts would still sit within the deepest path a part may
 * have.
 */
export const filePartOpensInside = (
  part: Pick<FilePartDescriptor, "fileName" | "mediaType" | "part">,
): boolean =>
  filePartPreviewKind(part.mediaType) === FILE_PART_PREVIEW_KIND.none &&
  opensToFilesInside(part);

/** Why a file inside a container does not open, as its row says it. */
export const FILE_PART_UNAVAILABLE_LABEL = {
  encrypted: "inspector.fileParts.unavailable.encrypted",
  unsupported: "inspector.fileParts.unavailable.unsupported",
  link: "inspector.fileParts.unavailable.link",
  tooLarge: "inspector.fileParts.unavailable.tooLarge",
  unreadable: "inspector.fileParts.unavailable.unreadable",
} as const satisfies Record<FilePartUnavailableReason, TranslationKey>;

/** A declared charset the text preview decodes with; null for any other. */
const textCharsetOf = (
  charset: string | null | undefined,
): EmailTextAttachmentCharset | null =>
  Object.values(EMAIL_TEXT_ATTACHMENT_CHARSET).find(
    (known) => known === charset,
  ) ?? null;

/**
 * A container's files as list rows, in its order: a file that opens as its
 * part (its folder as the row's second line), any other with its reason.
 */
export const containedFileRows = (files: readonly ContainedFile[]) =>
  files.map((file, position) =>
    file.part === null
      ? {
          type: "unavailable" as const,
          key: `unavailable:${String(position)}`,
          file,
        }
      : {
          type: "part" as const,
          key: file.part.part,
          part: {
            ...file.part,
            detail: file.folder,
            charset: textCharsetOf(file.charset),
          },
        },
  );

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
