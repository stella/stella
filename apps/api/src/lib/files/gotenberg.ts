import { panic, Result, TaggedError } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { fetchWithTimeout } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";

import { env } from "@/api/env";
import { basicAuthorizationHeader } from "@/api/lib/auth/http-basic-auth";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  checkConversionInput,
  type ConversionInputRefusal,
} from "@/api/lib/files/conversion-input";
import type { DerivativeAdmissionError } from "@/api/lib/files/derivative-admission";
import { admitDerivativeImage } from "@/api/lib/files/derivative-admission";
import type { ImageHeader } from "@/api/lib/files/image-header";
import { readImageHeader } from "@/api/lib/files/image-header";
import type { EmbeddableImageMimeType } from "@/api/lib/files/image-pdf";
import {
  canEmbedInProcess,
  imageToPdf,
  isEmbeddableImageMimeType,
} from "@/api/lib/files/image-pdf";
import { streamMultipartForm } from "@/api/lib/files/multipart-stream";
import { isConvertibleMimeType } from "@/api/lib/files/pdf-derivative-policy";
import { applyFitToPage } from "@/api/lib/files/xlsx-preprocess";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { withTimeout } from "@/api/lib/with-timeout";

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
  kind: "http" | "transport" | "response-too-large";
  statusCode?: number;
  cause?: unknown;
}> {}

class ImagePdfError extends TaggedError("ImagePdfError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * An image the converter cannot import that could not be turned into a PDF
 * in-process either. Sending it to the converter instead would fail on every
 * attempt, so this is the conversion's final answer.
 */
export class ImageTranscodeError extends TaggedError("ImageTranscodeError")<{
  message: string;
  cause?: unknown;
}> {}

export type ConversionInputErrorReason = ConversionInputRefusal;

export class ConversionInputError extends TaggedError("ConversionInputError")<{
  message: string;
  reason: ConversionInputErrorReason;
  cause?: unknown;
}> {}

const conversionInputRefusalMessage = (
  reason: ConversionInputRefusal,
): string => {
  switch (reason.kind) {
    case "external_reference":
      return "The document contains a reference that cannot be converted.";
    case "unsupported_encoding":
      return `The document encoding ${reason.encoding} cannot be converted.`;
    case "unsupported_reference":
      return `This document refers to an external resource in ${reason.element} ${reason.attribute}, so it can't be converted.`;
    case "unsupported_field":
      return `The document field ${reason.fieldType} cannot be converted.`;
    case "legacy_format":
      return `Re-save this document as ${reason.replacementExtension} to convert it.`;
    case "inspection_failed":
      return "The document could not be inspected for conversion.";
    default:
      reason satisfies never;
      return panic("Unexpected conversion input refusal");
  }
};

type ConvertToPdfError =
  | DerivativeAdmissionError
  | ConversionInputError
  | GotenbergError
  | ImageTranscodeError;

const IMAGE_EMBED_FAILED_SINK = failureSink({
  event: "file_conversion.image_embed_failed",
  expected: [],
});

const IMAGE_TRANSCODE_FAILED_SINK = failureSink({
  event: "file_conversion.image_transcode_failed",
  expected: [],
});

/**
 * Image types the converter's LibreOffice route has no import filter for:
 * Gotenberg 8.37 accepts .bmp, .gif, .tif/.tiff, .png and .jpg/.jpeg, but
 * not .webp. These are re-encoded as PNG in-process and embedded directly.
 */
const IN_PROCESS_ONLY_IMAGE_MIME_TYPES = {
  "image/webp": null,
} as const satisfies Record<string, null>;

const isInProcessOnlyImageMimeType = (mimeType: string): boolean =>
  Object.hasOwn(IN_PROCESS_ONLY_IMAGE_MIME_TYPES, mimeType);

/**
 * Extensions the converter's LibreOffice route accepts for each image type
 * it renders, canonical first. The route picks its import filter by the
 * uploaded filename's extension, so an image named without one (or with the
 * wrong one) would fail to convert.
 */
const CONVERTER_IMAGE_EXTENSIONS: ReadonlyMap<
  string,
  readonly [string, ...string[]]
> = new Map([
  ["image/bmp", ["bmp"]],
  ["image/gif", ["gif"]],
  ["image/jpeg", ["jpg", "jpeg"]],
  ["image/png", ["png"]],
  ["image/tiff", ["tiff", "tif"]],
]);

/**
 * The (unsanitized) name to upload a file to the converter under. An image
 * keeps its extension when it is one the converter accepts for the image's
 * type; a missing or wrong extension is replaced by the type's canonical
 * one. Other types keep the uploaded name.
 */
const withConverterExtension = (fileName: string, mimeType: string): string => {
  const accepted = CONVERTER_IMAGE_EXTENSIONS.get(mimeType);
  if (accepted === undefined) {
    return fileName;
  }
  // A dot only starts an extension inside the last path segment, and not as
  // its first character (a dotfile name has no extension).
  const segmentStart =
    Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1;
  const lastDot = fileName.lastIndexOf(".");
  const hasExtension = lastDot > segmentStart;
  const extension = hasExtension
    ? fileName.slice(lastDot + 1).toLowerCase()
    : null;
  if (extension !== null && accepted.includes(extension)) {
    return fileName;
  }
  const stem = hasExtension ? fileName.slice(0, lastDot) : fileName;
  const [canonical] = accepted;
  return `${stem}.${canonical}`;
};

const gotenbergAuth = (): string =>
  basicAuthorizationHeader(env.GOTENBERG_USERNAME, env.GOTENBERG_PASSWORD);

const GOTENBERG_RETRY = {
  times: 2,
  delayMs: 2000,
  backoff: "exponential",
  shouldRetry: (error: GotenbergError) =>
    error.kind === "transport" ||
    (error.kind === "http" && (error.statusCode ?? 0) >= 500),
} as const;

const tooLargeConverterResponse = () =>
  new GotenbergError({
    message: `Gotenberg PDF exceeds the ${LIMITS.fileDerivativePdfMaxBytes}-byte limit`,
    kind: "response-too-large",
  });

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

const embedImage = async (
  bytes: Uint8Array,
  header: ImageHeader,
  mimeType: EmbeddableImageMimeType,
): Promise<Result<ConvertToPdfResult, ImagePdfError>> =>
  await Result.tryPromise({
    try: async () => {
      const pdf = await imageToPdf({ bytes, header, mimeType });
      return { buffer: toArrayBuffer(pdf), sizeBytes: pdf.byteLength };
    },
    catch: (cause) =>
      new ImagePdfError({ message: "Failed to embed image", cause }),
  });

/**
 * Re-encode an admitted image the converter cannot import as PNG and embed
 * that. Admission already bounded the declared pixel count; the decoder
 * enforces the same budget and the pipeline runs under the derivative
 * wall-clock ceiling. The PNG carries no EXIF, so its header's orientation
 * (1) is what the WebP header reader reports for the source too.
 */
const transcodeImageToPdf = async (
  bytes: Uint8Array,
): Promise<Result<ConvertToPdfResult, ImageTranscodeError>> => {
  Bun.Image.backend = "bun";
  const png = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () =>
          await new Bun.Image(bytes, {
            maxPixels: LIMITS.imageDerivativeSourcePixelsMax,
          })
            .png()
            .bytes(),
        {
          label: "image-transcode",
          timeoutMs: LIMITS.imageDerivativeTimeoutMs,
        },
      ),
    catch: (cause) =>
      new ImageTranscodeError({ message: "Failed to decode image", cause }),
  });
  if (Result.isError(png)) {
    return png;
  }
  const header = readImageHeader(png.value, "image/png");
  if (header === null || !canEmbedInProcess(header)) {
    return Result.err(
      new ImageTranscodeError({
        message: "Transcoded image is not an embeddable PNG",
      }),
    );
  }
  const embedded = await embedImage(png.value, header, "image/png");
  if (Result.isError(embedded)) {
    return Result.err(
      new ImageTranscodeError({
        message: "Failed to embed transcoded image",
        cause: embedded.error,
      }),
    );
  }
  return Result.ok(embedded.value);
};

/**
 * Convert a scanned file to PDF. Images are admitted by the pixel count
 * their header declares before anything decodes them. JPEG and PNG whose
 * header shows an encoding the in-process embedder handles become a
 * one-page PDF directly. WebP, which the converter cannot import, is
 * re-encoded as PNG in-process and embedded; a failure there is observed
 * and returned as an `ImageTranscodeError`, never sent to the converter.
 * Every other image (BMP, GIF, TIFF, and JPEG/PNG encodings the embedder
 * does not handle), an embed that fails anyway, and every other type go to
 * Gotenberg's LibreOffice route.
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
  if (header !== null && isInProcessOnlyImageMimeType(mimeType)) {
    const transcoded = await transcodeImageToPdf(bytes);
    if (Result.isError(transcoded)) {
      observeFailure(transcoded.error, {
        sink: IMAGE_TRANSCODE_FAILED_SINK,
        ctx: { operation: "image-transcode-to-pdf" },
      });
    }
    return transcoded;
  }

  if (
    header !== null &&
    isEmbeddableImageMimeType(mimeType) &&
    canEmbedInProcess(header)
  ) {
    const embedded = await embedImage(bytes, header, mimeType);
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

  if (isConvertibleMimeType(mimeType)) {
    const inspection = await Result.tryPromise({
      try: async () => await checkConversionInput(mimeType, bytes),
      catch: (cause) =>
        new ConversionInputError({
          message: "The document could not be inspected for conversion.",
          reason: { kind: "inspection_failed" },
          cause,
        }),
    });
    if (Result.isError(inspection)) {
      return inspection;
    }
    if (inspection.value.kind === "refuse") {
      return Result.err(
        new ConversionInputError({
          message: conversionInputRefusalMessage(inspection.value.reason),
          reason: inspection.value.reason,
        }),
      );
    }
  }

  const converted = await Result.tryPromise(
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
            fileName: sanitizeFilenamePreservingExtension(
              withConverterExtension(fileName, mimeType),
            ),
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
            kind: "http",
            statusCode: response.status,
          });
        }

        const contentLength = response.headers.get("content-length");
        const declaredBytes =
          contentLength === null
            ? null
            : parseIntegerToken(contentLength, { sign: "unsigned" }).unwrapOr(
                Number.POSITIVE_INFINITY,
              );
        if (
          declaredBytes !== null &&
          declaredBytes > LIMITS.fileDerivativePdfMaxBytes
        ) {
          await response.body?.cancel();
          return { type: "too-large" } as const;
        }
        const responseBytes =
          response.body === null
            ? new Uint8Array()
            : await readCappedBytes(
                response.body,
                LIMITS.fileDerivativePdfMaxBytes,
              );
        if (responseBytes === null) {
          return { type: "too-large" } as const;
        }
        const result = toArrayBuffer(responseBytes);
        return {
          type: "converted",
          converted: { buffer: result, sizeBytes: result.byteLength },
        } as const;
      },
      catch: (cause) => {
        if (cause instanceof GotenbergError) {
          return cause;
        }
        return new GotenbergError({
          message: "Failed to reach Gotenberg",
          kind: "transport",
          cause,
        });
      },
    },
    retry === "in-call" ? { retry: GOTENBERG_RETRY } : undefined,
  );
  if (Result.isError(converted)) {
    return converted;
  }
  // An oversized converter response is final: a retry returns the same PDF.
  return converted.value.type === "too-large"
    ? Result.err(tooLargeConverterResponse())
    : Result.ok(converted.value.converted);
};
