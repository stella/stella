import {
  DOCUMENT_PROPERTIES_MAX_BYTES,
  hasDocumentProperties,
} from "@stll/api-contract";
import { FILE_DOWNLOAD_RENDITIONS } from "@stll/api-contract/file-download-renditions";
import type { FileDownloadRendition } from "@stll/api-contract/file-download-renditions";

import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

/**
 * The alternative copies of a file the app can offer, in the order they are
 * offered. `original` and `withComments` are listed only where the plain
 * Download is a PDF with the reader's highlights written in (and nothing
 * else): the untouched upload and the copy with comments and author names
 * are one click further.
 */
export type DownloadRendition = FileDownloadRendition;

/**
 * What a download hands over: the uploaded bytes, the PDF with the reader's
 * highlights (`marked`), or one rendition of them.
 */
export type DownloadVariant =
  DownloadRendition | "marked" | "reference-scrubbed";

/** What the plain Download hands over. */
type PrimaryDownloadVariant = Extract<DownloadVariant, "original" | "marked">;

/**
 * What the plain Download of a file hands over, read off the renditions it is
 * offered: where the upload is listed as an alternative, the Download is the
 * PDF with the reader's highlights. One rule for every Download button.
 */
export const getPrimaryDownloadVariant = (
  renditions: readonly DownloadRendition[],
): PrimaryDownloadVariant =>
  renditions.includes("original") ? "marked" : "original";

export type DownloadOptions = {
  metadata: "keep" | "strip";
  /** The plain Download, which the options apply to when none is chosen. */
  primary: PrimaryDownloadVariant;
  reference: "include" | "omit";
};

export const getDownloadVariant = ({
  metadata,
  primary,
  reference,
}: DownloadOptions): DownloadVariant => {
  if (reference === "include") {
    return metadata === "strip" ? "reference-scrubbed" : "reference";
  }
  return metadata === "strip" ? "scrubbed" : primary;
};

type DownloadRenditionsInput = {
  /** Whether the API can strip this file's embedded metadata. */
  canScrub: boolean;
  /**
   * The document reference frozen onto the version being downloaded, or null
   * when it carries none. Per version: the matter's reference is not a proxy
   * for it, because a version created before the matter got one is stamped
   * null and the reference copy the server builds from it does not exist.
   */
  currentVersionReference: string | null | undefined;
  /**
   * Whether the file is encrypted at rest. `undefined` where the caller has
   * not resolved the field yet: the reference copy is built per request from
   * the stored bytes, so an unreadable file reads as ineligible rather than as
   * a download that fails at the click.
   */
  encrypted: boolean | undefined;
  hasPdfConversion: boolean;
  mimeType: string | undefined;
};

/**
 * The single owner of which alternative renditions a file can be downloaded
 * as, shared by the matter row menu and the inspector header so the two entry
 * points cannot offer different lists. Only DOCX can be handed over with its
 * reference: the reference is written into the document body, which no other
 * format the app serves can carry. A PDF the server can read downloads with
 * the reader's highlights, so its upload as stored and the copy with comments
 * are offered beside it.
 */
export const getDownloadRenditions = ({
  canScrub,
  currentVersionReference,
  encrypted,
  hasPdfConversion,
  mimeType,
}: DownloadRenditionsInput): readonly DownloadRendition[] => {
  // The server writes marks into a PDF it can read.
  const carriesMarks = encrypted === false && mimeType === PDF_MIME;
  const isAvailable = {
    original: carriesMarks,
    withComments: carriesMarks,
    pdf: hasPdfConversion,
    reference:
      Boolean(currentVersionReference) &&
      encrypted === false &&
      mimeType === DOCX_MIME,
    scrubbed: canScrub,
  } as const satisfies Record<DownloadRendition, boolean>;

  return FILE_DOWNLOAD_RENDITIONS.filter((rendition) => isAvailable[rendition]);
};

/**
 * Only formats whose embedded metadata the API can actually strip, and only
 * within the size it will read: offering the action on a file the server would
 * refuse is worse than not offering it.
 */
export const canDownloadScrubbed = (file: {
  encrypted: boolean;
  mimeType: string;
  sizeBytes: number;
}): boolean =>
  !file.encrypted &&
  file.sizeBytes <= DOCUMENT_PROPERTIES_MAX_BYTES &&
  hasDocumentProperties(file.mimeType);

/**
 * The one owner of which renditions this entity's file field can be downloaded
 * as, shared by the inspector header and the document route toolbar. The
 * entity read resolves every input the policy needs — the field's encryption,
 * size, stored PDF conversion, and the reference frozen onto the current
 * version — so an unread entity offers nothing rather than an action that
 * fails at the click.
 */
export const getEntityFileDownloadRenditions = ({
  entityData,
  fieldId,
}: {
  entityData:
    | {
        currentVersionReference: string | null;
        fields: {
          content: {
            encrypted?: boolean | undefined;
            mimeType?: string | undefined;
            pdfFileId?: string | null | undefined;
            sizeBytes?: number | undefined;
            type: string;
          };
          id: string;
        }[];
      }
    | undefined;
  fieldId: string;
}): readonly DownloadRendition[] => {
  const field = entityData?.fields.find(
    (candidate) => candidate.id === fieldId,
  );
  const content = field?.content.type === "file" ? field.content : undefined;
  const encrypted = content?.encrypted;
  const mimeType = content?.mimeType;
  const sizeBytes = content?.sizeBytes;

  return getDownloadRenditions({
    canScrub:
      encrypted !== undefined &&
      mimeType !== undefined &&
      sizeBytes !== undefined &&
      canDownloadScrubbed({ encrypted, mimeType, sizeBytes }),
    currentVersionReference: entityData?.currentVersionReference,
    encrypted,
    hasPdfConversion:
      (content?.pdfFileId ?? null) !== null && mimeType !== PDF_MIME,
    mimeType,
  });
};

export const getPdfDownloadFileName = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex <= 0) {
    return `${fileName}.pdf`;
  }

  return `${fileName.slice(0, dotIndex)}.pdf`;
};
