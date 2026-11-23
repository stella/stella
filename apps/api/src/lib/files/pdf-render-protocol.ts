import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";

/**
 * Convertible types whose PDF is rendered by stella itself, in the PDF
 * worker, and never sent to the converter: every image type, laid out one
 * image per page, and plain text and CSV, laid out with the fonts stella
 * ships. A failure there is the conversion's answer for that file.
 */
export const RENDERED_PDF_MIME_TYPES = {
  "image/bmp": "image",
  "image/gif": "image",
  "image/jpeg": "image",
  "image/png": "image",
  "image/tiff": "image",
  "image/webp": "image",
  "text/csv": "text",
  "text/plain": "text",
} as const satisfies Record<
  Extract<ConvertibleMime, `image/${string}` | "text/csv" | "text/plain">,
  "image" | "text"
>;

export type RenderedPdfMimeType = keyof typeof RENDERED_PDF_MIME_TYPES;

export const isRenderedPdfMimeType = (
  mimeType: string,
): mimeType is RenderedPdfMimeType =>
  Object.hasOwn(RENDERED_PDF_MIME_TYPES, mimeType);
