/**
 * HEIF image types: HEIC photos and HEIF image sequences.
 *
 * Their preview PDF is rendered by the PDF worker (`pdf-render.ts`) with
 * `@stll/heic-decoder`, only when the deployment turns that on
 * (`HEIC_PREVIEW_DECODING_ENABLED`); the container probe in
 * `image-header.ts` reads their size and orientation either way.
 */

import { documentFormat } from "@stll/api-contract/document-format";

import type { RenderedPdfMimeType } from "@/api/lib/files/pdf-render-protocol";

const HEIF_MIME_TYPES = {
  "image/heic": null,
  "image/heic-sequence": null,
  "image/heif": null,
  "image/heif-sequence": null,
} as const satisfies Record<
  Extract<RenderedPdfMimeType, `image/hei${string}`>,
  null
>;

export type HeifMimeType = keyof typeof HEIF_MIME_TYPES;

/** Whether `mimeType` (an essence, without parameters) is a HEIF type. */
export const isHeifMimeType = (mimeType: string): mimeType is HeifMimeType =>
  Object.hasOwn(HEIF_MIME_TYPES, mimeType);

/** The file's short tag ("HEIC", "HEIF") for a message about it. */
export const heifFormatLabel = (
  mimeType: HeifMimeType,
  fileName: string,
): string => documentFormat(mimeType, fileName).label ?? "HEIF";
