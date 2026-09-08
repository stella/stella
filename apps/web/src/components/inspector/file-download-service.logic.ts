import {
  DOCUMENT_PROPERTIES_MAX_BYTES,
  hasDocumentProperties,
} from "@stll/api-contract";

import { DOCX_MIME } from "@/lib/consts";

/**
 * The alternative copies of a file the app can build, in the order they are
 * offered. The plain Download is always the bytes as uploaded, on every
 * surface, so `original` is deliberately not one of them: nothing here decides
 * what a Download click does.
 */
const DOWNLOAD_RENDITIONS = ["reference", "pdf", "scrubbed"] as const;

export type DownloadRendition = (typeof DOWNLOAD_RENDITIONS)[number];

/** What a download hands over: the uploaded bytes, or one rendition of them. */
export type DownloadVariant = "original" | DownloadRendition;

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
 * format the app serves can carry.
 */
export const getDownloadRenditions = ({
  canScrub,
  currentVersionReference,
  encrypted,
  hasPdfConversion,
  mimeType,
}: DownloadRenditionsInput): readonly DownloadRendition[] => {
  const isAvailable = {
    pdf: hasPdfConversion,
    reference:
      Boolean(currentVersionReference) &&
      encrypted === false &&
      mimeType === DOCX_MIME,
    scrubbed: canScrub,
  } as const satisfies Record<DownloadRendition, boolean>;

  return DOWNLOAD_RENDITIONS.filter((rendition) => isAvailable[rendition]);
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

export const getPdfDownloadFileName = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex <= 0) {
    return `${fileName}.pdf`;
  }

  return `${fileName.slice(0, dotIndex)}.pdf`;
};
