import { Result, TaggedError } from "better-result";

import { fetchWithTimeout } from "@stll/fetch";

import { env } from "@/api/env";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import type { DerivativeAdmissionError } from "@/api/lib/files/derivative-admission";
import { admitDerivativeImage } from "@/api/lib/files/derivative-admission";
import {
  canEmbedInProcess,
  imageToPdf,
  isEmbeddableImageMimeType,
} from "@/api/lib/files/image-pdf";
import { streamMultipartForm } from "@/api/lib/files/multipart-stream";
import { applyFitToPage } from "@/api/lib/files/xlsx-preprocess";
import { basicAuthorizationHeader } from "@/api/lib/http-basic-auth";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

export {
  isConvertibleMimeType,
  isNativelyRenderableMimeType,
  pdfDerivativeStateForFile,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/pdf-derivative-policy";

/**
 * Spreadsheet MIME types (.xls, .xlsx) that benefit from the
 * fit-to-page pre-processor. ODS uses ODF format (different ZIP
 * structure), so we skip it.
 */
const XLSX_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

type ConvertToPdfResult = {
  buffer: ArrayBuffer;
  sizeBytes: number;
};

class GotenbergError extends TaggedError("GotenbergError")<{
  message: string;
  statusCode?: number;
  cause?: unknown;
}> {}

class ImagePdfError extends TaggedError("ImagePdfError")<{
  message: string;
  cause?: unknown;
}> {}

type ConvertToPdfError = DerivativeAdmissionError | GotenbergError;

const IMAGE_EMBED_FAILED_SINK = failureSink({
  event: "file_conversion.image_embed_failed",
  expected: [],
});

const gotenbergAuth = (): string =>
  basicAuthorizationHeader(env.GOTENBERG_USERNAME, env.GOTENBERG_PASSWORD);

const GOTENBERG_RETRY = {
  times: 2,
  delayMs: 2000,
  backoff: "exponential",
  shouldRetry: (error: GotenbergError) =>
    error.statusCode === undefined || error.statusCode >= 500,
} as const;

type ConvertToPdfOptions = {
  /**
   * Who retries a failed converter call. `in-call` retries transient
   * converter failures inside this call, for request paths where nothing
   * else would. `caller` makes one call at most one conversion, for callers
   * whose own retry policy (a queue's attempts) already bounds the total, so
   * the two never multiply into repeated full-size conversions.
   */
  retry?: "in-call" | "caller";
};

/** The bytes of `view` as an `ArrayBuffer`, without a copy when they already are one. */
const toArrayBuffer = (view: Uint8Array): ArrayBuffer =>
  view.buffer instanceof ArrayBuffer &&
  view.byteOffset === 0 &&
  view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.slice().buffer;

/**
 * Convert a scanned file to PDF. Images are admitted by the pixel count
 * their header declares before anything decodes them. JPEG and PNG whose
 * header shows an encoding the in-process embedder handles become a
 * one-page PDF directly; every other image, an embed that fails anyway, and
 * every other type go to Gotenberg's LibreOffice route.
 */
export const convertToPdf = async (
  file: ScannedFile,
  { retry = "in-call" }: ConvertToPdfOptions = {},
): Promise<Result<ConvertToPdfResult, ConvertToPdfError>> => {
  const { fileName, mimeType } = file;
  const bytes = new Uint8Array(file.bytes);
  const admission = admitDerivativeImage(bytes, mimeType);
  if (admission.type === "refused") {
    return Result.err(admission.error);
  }

  const { header } = admission;
  if (
    header !== null &&
    isEmbeddableImageMimeType(mimeType) &&
    canEmbedInProcess(header)
  ) {
    const embedded = await Result.tryPromise({
      try: async () => {
        const pdf = await imageToPdf({ bytes, header, mimeType });
        return { buffer: toArrayBuffer(pdf), sizeBytes: pdf.byteLength };
      },
      catch: (cause) =>
        new ImagePdfError({ message: "Failed to embed image", cause }),
    });
    // An embed failure never reaches the caller (it falls back below), so
    // only the value crosses into the caller-facing error type.
    if (Result.isOk(embedded)) {
      return Result.ok(embedded.value);
    }
    // The header promised an encoding the embedder then refused: observe
    // it and let the converter render the image instead.
    observeFailure(embedded.error, {
      sink: IMAGE_EMBED_FAILED_SINK,
      ctx: { operation: "image-to-pdf" },
    });
  }

  return await Result.tryPromise(
    {
      try: async () => {
        const source = XLSX_MIME_TYPES.has(mimeType)
          ? new Uint8Array(await applyFitToPage(file.bytes))
          : bytes;
        // Streamed from the caller's buffer, so the request holds no second
        // copy of the source.
        const form = streamMultipartForm({
          file: {
            fieldName: "files",
            // The converter picks its import filter by extension.
            fileName: sanitizeFilenamePreservingExtension(fileName),
            bytes: source,
          },
          fields: { exportNotes: "true", exportNotesInMargin: "true" },
        });
        const response = await fetchWithTimeout(
          `${env.GOTENBERG_URL}/forms/libreoffice/convert`,
          {
            method: "POST",
            headers: {
              Authorization: gotenbergAuth(),
              "Content-Type": form.contentType,
              "Content-Length": String(form.contentLength),
            },
            body: form.body,
            timeoutMs: 30_000,
          },
        );

        if (!response.ok) {
          throw new GotenbergError({
            message: `Gotenberg returned ${response.status}`,
            statusCode: response.status,
          });
        }

        const result = await response.arrayBuffer();
        return { buffer: result, sizeBytes: result.byteLength };
      },
      catch: (cause) => {
        if (cause instanceof GotenbergError) {
          return cause;
        }
        return new GotenbergError({
          message: "Failed to reach Gotenberg",
          cause,
        });
      },
    },
    retry === "in-call" ? { retry: GOTENBERG_RETRY } : undefined,
  );
};
