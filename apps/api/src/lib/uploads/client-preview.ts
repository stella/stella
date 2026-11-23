/**
 * Client previews of HEIC/HEIF photos.
 *
 * A client whose platform decodes HEIC itself (Apple's and Android's image
 * decoders, Safari) may upload a JPEG or WebP rendering of the photo next to
 * the original, so the server can build the photo's preview PDF without
 * decoding HEIC. The preview is never trusted as it arrives:
 *
 * - it is declared at reservation (type, size, SHA-256, displayed size) and
 *   PUT to a staging key signed against that size and checksum, like the
 *   original;
 * - the PDF derivative job reads it back within its declared size, checks
 *   its checksum again, scans it as any upload, and accepts it only when its
 *   header shows the declared type and size, at most the page-image budget,
 *   and the shape the original's own header declares;
 * - the server then renders the preview PDF from it, through the same
 *   converter and with the same storage, access and audit as any derivative.
 *
 * A missing, late or refused preview changes nothing: the job decodes the
 * original as it would without one.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import type { SafeId } from "@/api/lib/branded-types";
import { scanUpload } from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { isHeifMimeType } from "@/api/lib/files/heif";
import {
  type ImageHeader,
  readImageHeader,
} from "@/api/lib/files/image-header";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  deleteS3ObjectWithSignal,
  readS3ObjectBoundedIfPresent,
} from "@/api/lib/s3";
import { tmpUploadKey } from "@/api/lib/uploads/runtime";

const CLIENT_PREVIEW_MIME_TYPES = ["image/jpeg", "image/webp"] as const;

/** A displayed side of a client preview, in pixels. */
const previewSideSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(LIMITS.pdfRenderImagePixelsMax),
);

/**
 * What a client declares about its preview when it reserves the upload:
 * its type, byte size and SHA-256, and its displayed (upright) size.
 */
export const clientPreviewDeclarationSchema = v.pipe(
  v.object({
    mimeType: v.picklist(CLIENT_PREVIEW_MIME_TYPES),
    size: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.clientPreviewBytesMax),
    ),
    sha256Hex: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    width: previewSideSchema,
    height: previewSideSchema,
  }),
  v.check(
    ({ height, width }) => width * height <= LIMITS.pdfRenderImagePixelsMax,
    `A client preview may hold at most ${LIMITS.pdfRenderImagePixelsMax} pixels`,
  ),
);

export type ClientPreviewDeclaration = v.InferOutput<
  typeof clientPreviewDeclarationSchema
>;

/** Whether a file of `mimeType` (an essence) may carry a client preview. */
export const acceptsClientPreview = (mimeType: string): boolean =>
  isHeifMimeType(mimeType);

/** The staging key of an upload's client preview, beside the original's. */
export const clientPreviewTmpKey = (originalTmpKey: string): string =>
  `${originalTmpKey}-preview`;

/** A preview handed to the PDF derivative job: where it is and what it claims. */
export type QueuedClientPreview = ClientPreviewDeclaration & { key: string };

/** The preview an upload declared, for the PDF derivative job, if any. */
export const queuedClientPreview = ({
  declaration,
  organizationId,
  uploadId,
  workspaceId,
}: {
  declaration: ClientPreviewDeclaration | undefined;
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"pendingUpload">;
  workspaceId: SafeId<"workspace">;
}): QueuedClientPreview | undefined =>
  declaration === undefined
    ? undefined
    : {
        ...declaration,
        key: clientPreviewTmpKey(
          tmpUploadKey({ organizationId, uploadId, workspaceId }),
        ),
      };

/** Width and height as the image is displayed, after its orientation. */
const displayedSize = ({ height, orientation, width }: ImageHeader) =>
  orientation >= 5 ? { width: height, height: width } : { width, height };

/** Shapes within this relative difference are the same picture's. */
const ASPECT_TOLERANCE = 0.01;
/** A preview's longer side may be no shorter than this, unless the photo's is. */
const PREVIEW_MIN_LONG_SIDE = 1024;

export type ClientPreviewRefusal =
  | "original-unreadable"
  | "preview-unreadable"
  | "size-mismatch"
  | "too-large"
  | "too-small"
  | "shape-mismatch";

/**
 * Why a preview cannot stand for the photo, or `null` when it can: its
 * header must show the declared type and displayed size, within the
 * page-image budget, at least `PREVIEW_MIN_LONG_SIDE` on its longer side
 * (or the photo's own), in the photo's shape.
 */
export const clientPreviewRefusal = ({
  declared,
  original,
  preview,
}: {
  declared: ClientPreviewDeclaration;
  original: ImageHeader | null;
  preview: ImageHeader | null;
}): ClientPreviewRefusal | null => {
  if (original === null) {
    return "original-unreadable";
  }
  if (preview === null) {
    return "preview-unreadable";
  }
  const shown = displayedSize(preview);
  if (shown.width !== declared.width || shown.height !== declared.height) {
    return "size-mismatch";
  }
  if (shown.width * shown.height > LIMITS.pdfRenderImagePixelsMax) {
    return "too-large";
  }
  const photo = displayedSize(original);
  const longSide = Math.max(shown.width, shown.height);
  if (
    longSide <
    Math.min(PREVIEW_MIN_LONG_SIDE, Math.max(photo.width, photo.height))
  ) {
    return "too-small";
  }
  const photoAspect = photo.width / photo.height;
  const previewAspect = shown.width / shown.height;
  if (Math.abs(previewAspect / photoAspect - 1) > ASPECT_TOLERANCE) {
    return "shape-mismatch";
  }
  return null;
};

/** How long reading or removing a staged preview may take. */
const PREVIEW_IO_TIMEOUT_MS = 30_000;

export type LoadedClientPreview =
  | { type: "accepted"; preview: ScannedFile }
  | {
      type: "refused";
      reason:
        ClientPreviewRefusal | "missing" | "unreadable" | "checksum" | "scan";
    };

/**
 * Reads the staged preview back and decides whether it stands for the
 * photo whose header is `original`. The staged object stays where it is, so
 * a retried attempt reads it again; the job removes it with
 * `removeClientPreview` once the derivative is settled.
 */
export const loadClientPreview = async ({
  original,
  queued,
}: {
  original: ImageHeader | null;
  queued: QueuedClientPreview;
}): Promise<LoadedClientPreview> => {
  const signal = AbortSignal.timeout(PREVIEW_IO_TIMEOUT_MS);
  // A failed read (a timeout, a storage error) refuses the preview, so the
  // job renders the photo itself instead of failing the attempt.
  const read = await Result.tryPromise(
    async () =>
      await readS3ObjectBoundedIfPresent({
        key: queued.key,
        maxBytes: queued.size,
        signal,
      }),
  );
  if (Result.isError(read)) {
    return { type: "refused", reason: "unreadable" };
  }
  const bytes = read.value;
  if (bytes === null) {
    return { type: "refused", reason: "missing" };
  }
  // The PUT URL outlives finalize: what is there now must be what was declared.
  if (
    bytes.byteLength !== queued.size ||
    sha256Hex(bytes) !== queued.sha256Hex
  ) {
    return { type: "refused", reason: "checksum" };
  }
  const refusal = clientPreviewRefusal({
    declared: queued,
    original,
    preview: readImageHeader(bytes, queued.mimeType),
  });
  if (refusal !== null) {
    return { type: "refused", reason: refusal };
  }
  const scanned = await scanUpload({
    bytes,
    ownership: "transfer",
    declaredMimeType: queued.mimeType,
    fileName: queued.mimeType === "image/jpeg" ? "preview.jpg" : "preview.webp",
  });
  return Result.isOk(scanned)
    ? { type: "accepted", preview: scanned.value }
    : { type: "refused", reason: "scan" };
};

/**
 * Removes the staged preview once its derivative is settled (published, or
 * refused for good). A failed removal is left to the bucket's
 * temporary-upload rule, which also collects the preview of a job that
 * exhausted its attempts.
 */
export const removeClientPreview = async (
  queued: QueuedClientPreview,
): Promise<void> => {
  const signal = AbortSignal.timeout(PREVIEW_IO_TIMEOUT_MS);
  const removed = await Result.tryPromise(
    async () => await deleteS3ObjectWithSignal(queued.key, signal),
  );
  if (Result.isError(removed)) {
    logger.info("file_derivative.client_preview_not_removed", {
      key: queued.key,
    });
  }
};
