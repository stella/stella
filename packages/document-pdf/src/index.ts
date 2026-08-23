import { createHash } from "node:crypto";

import {
  convert_external_detection_batch,
  loadNativeAnonymizeBinding,
  type ExternalDetectionBatch,
  type PreparedNativePipeline,
} from "@stll/anonymize";

import {
  PDF_INSPECTION_ERROR_CODES,
  PDF_RASTER_ERROR_CODES,
  type PdfInspection,
  type PdfInspectionErrorCode,
  type PdfPageObservation,
  type PdfRasterProvider,
  type PdfRasterErrorCode,
  type PdfRasterRewrite,
  type PdfRasterRewriteResult,
} from "./types";
import {
  decodePdfInspection,
  decodePdfRasterRewriteCertificate,
} from "./native-codec";

export const PDF_INSPECTION_CONTRACT_VERSION = 1 as const;
export const PDF_RASTER_CONTRACT_VERSION = 1 as const;
export const PDF_RASTER_MAX_PAGE_BYTES = 128 * 1024 * 1024;
export const PDF_RASTER_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const PDF_RASTER_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
export const PDF_RASTER_REQUEST_JSON_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_STREAM_DECOMPRESSED_MAX_BYTES = 32 * 1024 * 1024;
export const PDF_LOADED_PAYLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const PDF_MAX_OBJECTS = 200_000;
export const PDF_MAX_OBJECT_NODES = 1_000_000;
export const PDF_MAX_OBJECT_DEPTH = 128;
export const PDF_MAX_PAGES = 10_000;
export const PDF_MAX_GLYPHS = 5_000_000;
export const PDF_MAX_PAGE_TEXT_UTF8_BYTES = 16 * 1024 * 1024;
export const PDF_MAX_OBSERVED_TEXT_UTF8_BYTES = 64 * 1024 * 1024;
export const PDF_OBSERVATIONS_JSON_MAX_BYTES = 64 * 1024 * 1024;
/** Renderer dimensions may differ by this many points due to numeric rounding. */
export const PDF_PAGE_DIMENSION_TOLERANCE_POINTS = 0.25;

export class PdfInspectionError extends Error {
  readonly code: PdfInspectionErrorCode;

  constructor(code: PdfInspectionErrorCode, message: string) {
    super(message);
    this.name = "PdfInspectionError";
    this.code = code;
  }
}

export class PdfRasterError extends Error {
  readonly code: PdfRasterErrorCode;

  constructor(code: PdfRasterErrorCode, message: string) {
    super(message);
    this.name = "PdfRasterError";
    this.code = code;
  }
}

const errorCode = (message: string): PdfInspectionErrorCode => {
  const code = Object.values(PDF_INSPECTION_ERROR_CODES).find((candidate) =>
    message.startsWith(`${candidate}:`),
  );
  return code ?? PDF_INSPECTION_ERROR_CODES.invalidDocument;
};

const rasterErrorCode = (message: string): PdfRasterErrorCode => {
  const code = Object.values(PDF_RASTER_ERROR_CODES).find((candidate) =>
    message.startsWith(`${candidate}:`),
  );
  return code ?? PDF_RASTER_ERROR_CODES.verificationFailed;
};

export type InspectPdfOptions = {
  pageObservations?: readonly PdfPageObservation[];
};

export const inspectPdf = (
  document: Uint8Array,
  options: InspectPdfOptions = {},
): PdfInspection => {
  const inspect = loadNativeAnonymizeBinding().inspectPdfJson;
  if (inspect === undefined) {
    throw new PdfInspectionError(
      PDF_INSPECTION_ERROR_CODES.invalidDocument,
      "Native anonymize binding does not expose PDF inspection",
    );
  }
  try {
    const observations = options.pageObservations;
    return decodePdfInspection(
      inspect(
        document,
        observations === undefined ? undefined : JSON.stringify(observations),
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "PDF inspection failed";
    throw new PdfInspectionError(errorCode(message), message);
  }
};

export type RewritePdfRasterFromDetectionsOptions = {
  document: Uint8Array;
  request: PdfRasterRewrite;
  /** One opaque, row-packed RGB8 buffer per request page, in page order. */
  pagePixels: readonly Uint8Array[];
};

/**
 * Advanced rewrite-only surface. It verifies structure and destructive pixels but
 * does not run detection or certify that the result is PII-free.
 */
export const rewritePdfRasterFromDetections = ({
  document,
  request,
  pagePixels,
}: RewritePdfRasterFromDetectionsOptions): PdfRasterRewriteResult => {
  const rewrite =
    loadNativeAnonymizeBinding().rewritePdfRasterFromDetectionsJson;
  if (rewrite === undefined) {
    throw new PdfRasterError(
      PDF_RASTER_ERROR_CODES.verificationFailed,
      "Native anonymize binding does not expose PDF raster rewriting",
    );
  }
  try {
    const result = rewrite(document, JSON.stringify(request), pagePixels);
    return {
      document: result.document,
      certificate: decodePdfRasterRewriteCertificate(result.certificateJson),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "PDF raster rewrite failed";
    throw new PdfRasterError(rasterErrorCode(message), message);
  }
};

export type PdfRasterObservedPageInput = {
  observation: PdfPageObservation;
  widthPixels: number;
  heightPixels: number;
  pixels: Uint8Array;
  /** Optional digest-bound provider batch merged through stella caller semantics. */
  externalDetectionBatch?: ExternalDetectionBatch | string | undefined;
};

export type AnonymizePdfRasterOptions = {
  document: Uint8Array;
  pipeline: Pick<
    PreparedNativePipeline,
    "redactText" | "redactTextWithCallerDetections"
  >;
  provider: PdfRasterProvider;
  pages: readonly PdfRasterObservedPageInput[];
  fillRgb?: readonly [number, number, number] | undefined;
};

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** Run stella detection, merge optional external detections, then rewrite pixels. */
export const anonymizePdfRaster = ({
  document,
  pipeline,
  provider,
  pages,
  fillRgb = [0, 0, 0],
}: AnonymizePdfRasterOptions): PdfRasterRewriteResult => {
  if (document.byteLength > PDF_DOCUMENT_MAX_BYTES) {
    throw new PdfRasterError(
      PDF_RASTER_ERROR_CODES.limitExceeded,
      "limit-exceeded: PDF source exceeds its byte limit",
    );
  }
  if (pages.length > PDF_MAX_PAGES) {
    throw new PdfRasterError(
      PDF_RASTER_ERROR_CODES.limitExceeded,
      "limit-exceeded: PDF raster page count exceeds its limit",
    );
  }
  let totalPixelBytes = 0;
  let totalObservedTextBytes = 0;
  const textEncoder = new TextEncoder();
  for (const page of pages) {
    if (typeof page.observation?.text !== "string") {
      throw new PdfRasterError(
        PDF_RASTER_ERROR_CODES.invalidContract,
        "invalid-contract: PDF raster observed text is invalid",
      );
    }
    const observedTextBytes = textEncoder.encode(
      page.observation.text,
    ).byteLength;
    if (observedTextBytes > PDF_MAX_PAGE_TEXT_UTF8_BYTES) {
      throw new PdfRasterError(
        PDF_RASTER_ERROR_CODES.limitExceeded,
        "limit-exceeded: PDF raster page text exceeds its byte limit",
      );
    }
    totalObservedTextBytes += observedTextBytes;
    if (totalObservedTextBytes > PDF_MAX_OBSERVED_TEXT_UTF8_BYTES) {
      throw new PdfRasterError(
        PDF_RASTER_ERROR_CODES.limitExceeded,
        "limit-exceeded: PDF raster observed text exceeds its aggregate byte limit",
      );
    }
    const { heightPixels, widthPixels } = page;
    if (
      !Number.isSafeInteger(widthPixels) ||
      !Number.isSafeInteger(heightPixels) ||
      widthPixels <= 0 ||
      heightPixels <= 0
    ) {
      throw new PdfRasterError(
        PDF_RASTER_ERROR_CODES.invalidContract,
        "invalid-contract: PDF raster pixel dimensions are invalid",
      );
    }
    const expected = widthPixels * heightPixels * 3;
    if (
      !Number.isSafeInteger(expected) ||
      expected > PDF_RASTER_MAX_PAGE_BYTES ||
      page.pixels.byteLength !== expected
    ) {
      throw new PdfRasterError(
        PDF_RASTER_ERROR_CODES.limitExceeded,
        "limit-exceeded: PDF raster page pixels exceed limits or have an invalid RGB8 length",
      );
    }
    totalPixelBytes += expected;
    if (
      !Number.isSafeInteger(totalPixelBytes) ||
      totalPixelBytes > PDF_RASTER_MAX_TOTAL_BYTES
    ) {
      throw new PdfRasterError(
        PDF_RASTER_ERROR_CODES.limitExceeded,
        "limit-exceeded: PDF raster pixels exceed their aggregate limit",
      );
    }
  }
  const binding = loadNativeAnonymizeBinding();
  let requestPages: PdfRasterRewrite["pages"];
  try {
    requestPages = pages.map((page) => {
      const external =
        page.externalDetectionBatch === undefined
          ? undefined
          : convert_external_detection_batch(
              new TextEncoder().encode(page.observation.text),
              page.externalDetectionBatch,
              { binding },
            );
      const result =
        external === undefined
          ? pipeline.redactText(page.observation.text)
          : pipeline.redactTextWithCallerDetections(page.observation.text, {
              detections: external,
            });
      return {
        observation: page.observation,
        widthPixels: page.widthPixels,
        heightPixels: page.heightPixels,
        pixelSha256: sha256(page.pixels),
        detections: result.resolvedEntities.map(({ start, end }) => ({
          start,
          end,
        })),
      };
    });
  } catch {
    throw new PdfRasterError(
      PDF_RASTER_ERROR_CODES.detectionFailed,
      "detection-failed: PDF raster detection failed",
    );
  }
  return rewritePdfRasterFromDetections({
    document,
    request: {
      contractVersion: PDF_RASTER_CONTRACT_VERSION,
      sourceSha256: sha256(document),
      provider,
      fillRgb,
      pages: requestPages,
    },
    pagePixels: pages.map(({ pixels }) => pixels),
  });
};

export { PDF_INSPECTION_ERROR_CODES } from "./types";
export { PDF_RASTER_ERROR_CODES } from "./types";
export {
  PDF_LOCAL_PROVIDER_ERROR_CODES,
  PdfLocalProviderError,
  renderPdfWithPopplerTesseract,
} from "./local-provider";
export type {
  LocalPdfRasterObservation,
  LocalPdfRasterPage,
  PdfLocalProviderErrorCode,
  RenderPdfWithPopplerTesseractOptions,
} from "./local-provider";
export type {
  PdfGlyphObservation,
  PdfInspection,
  PdfInspectionErrorCode,
  PdfInspectionGap,
  PdfPageInspection,
  PdfPageObservation,
  PdfRect,
  PdfRiskInventory,
  PdfRasterDetection,
  PdfRasterErrorCode,
  PdfRasterPage,
  PdfRasterProvider,
  PdfRasterRewrite,
  PdfRasterRewriteCertificate,
  PdfRasterRewriteResult,
} from "./types";
