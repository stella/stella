import { TaggedError } from "better-result";

import type { ImageHeader } from "@/api/lib/files/image-header";
import {
  isHeaderReadableImageMimeType,
  readImageHeader,
} from "@/api/lib/files/image-header";
import { LIMITS } from "@/api/lib/limits";

/**
 * Why a source is refused before any conversion work. Each refusal is a
 * deterministic property of the stored file, so retrying it cannot succeed:
 * callers turn it into a terminal state instead of a retry.
 */
export const DERIVATIVE_REFUSAL = {
  /** The stored object is larger than `fileDerivativeSourceMaxBytes`. */
  SOURCE_BYTES: "source-bytes",
  /** The image header declares more than `imageDerivativeSourcePixelsMax`. */
  SOURCE_PIXELS: "source-pixels",
  /** An image whose header cannot be read, so its cost is unknown. */
  UNREADABLE_HEADER: "unreadable-header",
} as const;

export type DerivativeRefusal =
  (typeof DERIVATIVE_REFUSAL)[keyof typeof DERIVATIVE_REFUSAL];

export class DerivativeAdmissionError extends TaggedError(
  "DerivativeAdmissionError",
)<{
  message: string;
  refusal: DerivativeRefusal;
}> {}

/** Refuse a source by its recorded size, before anything reads it. */
export const admitDerivativeSourceBytes = (
  sizeBytes: number,
): DerivativeAdmissionError | null =>
  sizeBytes > LIMITS.fileDerivativeSourceMaxBytes
    ? new DerivativeAdmissionError({
        message: `Source is ${sizeBytes} bytes, above the ${LIMITS.fileDerivativeSourceMaxBytes}-byte derivative budget`,
        refusal: DERIVATIVE_REFUSAL.SOURCE_BYTES,
      })
    : null;

type ImageAdmission =
  | { type: "admitted"; header: ImageHeader | null }
  | { type: "refused"; error: DerivativeAdmissionError };

/**
 * Refuse an image by the pixel count its header declares, before any decoder
 * allocates a surface. Non-image types pass with no header.
 */
export const admitDerivativeImage = (
  bytes: Uint8Array,
  mimeType: string,
): ImageAdmission => {
  if (!isHeaderReadableImageMimeType(mimeType)) {
    return { type: "admitted", header: null };
  }
  const header = readImageHeader(bytes, mimeType);
  if (header === null) {
    return {
      type: "refused",
      error: new DerivativeAdmissionError({
        message: `Cannot read the ${mimeType} header`,
        refusal: DERIVATIVE_REFUSAL.UNREADABLE_HEADER,
      }),
    };
  }
  const pixels = header.width * header.height;
  if (pixels > LIMITS.imageDerivativeSourcePixelsMax) {
    return {
      type: "refused",
      error: new DerivativeAdmissionError({
        message: `Image declares ${pixels} pixels, above the ${LIMITS.imageDerivativeSourcePixelsMax}-pixel derivative budget`,
        refusal: DERIVATIVE_REFUSAL.SOURCE_PIXELS,
      }),
    };
  }
  return { type: "admitted", header };
};
