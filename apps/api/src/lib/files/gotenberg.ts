import { panic, Result, TaggedError } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import {
  convertedDocumentFormatOfMimeType,
  type ConvertedDocumentMimeType,
  htmlRenderedDocumentFormatOfMimeType,
  type HtmlRenderedDocumentMimeType,
  isConvertedDocumentMimeType,
} from "@stll/api-contract/converted-document-formats";
import {
  declareFailureClass,
  declareFingerprintFields,
  type FailureReason,
} from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";

import { envConverter } from "@/api/env-converter";
import { basicAuthorizationHeader } from "@/api/lib/auth/http-basic-auth";
import { SUBPROCESS_TERMINATION_REASON } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { contentMatchesConvertibleMime } from "@/api/lib/files/conversion-content";
import {
  checkConversionInput,
  type ConversionInputRefusal,
} from "@/api/lib/files/conversion-input";
import { gotenbergConvertTarget } from "@/api/lib/files/converter-settings";
import type { DerivativeAdmissionError } from "@/api/lib/files/derivative-admission";
import {
  admitDerivativeImage,
  DERIVATIVE_REFUSAL,
} from "@/api/lib/files/derivative-admission";
import { type EbookError, ebookToHtml } from "@/api/lib/files/epub-document";
import {
  heifFormatLabel,
  type HeifMimeType,
  isHeifMimeType,
} from "@/api/lib/files/heif";
import type { ImageHeader } from "@/api/lib/files/image-header";
import type { EmbeddableImageMimeType } from "@/api/lib/files/image-pdf";
import {
  canEmbedInProcess,
  imageToPdf,
  isEmbeddableImageMimeType,
} from "@/api/lib/files/image-pdf";
import {
  type WebArchiveError,
  webArchiveToHtml,
} from "@/api/lib/files/mhtml-document";
import { streamMultipartForm } from "@/api/lib/files/multipart-stream";
import {
  type ConvertibleMime,
  isConvertibleMimeType,
  isHtmlRenderedMimeType,
  mediaTypeEssence,
} from "@/api/lib/files/pdf-derivative-policy";
import {
  isRenderedPdfMimeType,
  type RenderedPdfMimeType,
} from "@/api/lib/files/pdf-render-protocol";
import {
  PDF_WORKER_OPERATION,
  PDF_WORKER_PARSE_ERROR_EXIT_CODE,
  PDF_WORKER_TOO_LARGE_EXIT_CODE,
  pdfWorkerPath,
} from "@/api/lib/files/pdf-worker-protocol";
import { applyFitToPage } from "@/api/lib/files/xlsx-preprocess";
import { LIMITS } from "@/api/lib/limits";
import { admitWork, WorkRefusal } from "@/api/lib/load/work-admission";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

export {
  canConvertToPdf,
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

type PdfRenderFailureReason =
  "unreadable" | "too-large" | "memory" | "busy" | "failed";

/** How each reason a render fails for grades. */
const PDF_RENDER_FAILURE = {
  // The file's answer, not a defect.
  unreadable: "file_preview_unrenderable",
  "too-large": "file_preview_unrenderable",
  // A source bound let work through past the ceiling.
  memory: "tagged_failure",
  busy: "work_capacity_unavailable",
  failed: "tagged_failure",
} as const satisfies Record<PdfRenderFailureReason, FailureReason>;

/**
 * A file stella renders itself (see `pdf-render-protocol.ts`) whose PDF
 * could not be made. It is never sent to the converter instead, so this is
 * the conversion's answer: `unreadable` and `too-large` are properties of
 * the file and a retry gives the same answer. `memory` (the worker passed
 * `LIMITS.pdfRenderWorkerRssMaxBytes` and was killed) is too, but the
 * source bounds should have kept it under that, so it grades as a defect.
 * `busy` (no render slot came free in time) and `failed` (the worker timed
 * out, crashed or could not start) say nothing about the file.
 */
export class PdfRenderError extends TaggedError("PdfRenderError")<{
  message: string;
  reason: PdfRenderFailureReason;
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
    declareFailureClass(this, ({ reason }) => PDF_RENDER_FAILURE[reason]);
  }
}

export type ConversionInputErrorReason = ConversionInputRefusal;

export class ConversionInputError extends TaggedError("ConversionInputError")<{
  message: string;
  reason: ConversionInputErrorReason;
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason.kind"]);
  }
}

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
    case "no_preview":
      return reason.cause === "decoding_off"
        ? `This server makes no previews of ${reason.format} images.`
        : `This ${reason.format} image cannot be read for a preview.`;
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
  | PdfRenderError;

const IMAGE_EMBED_FAILED_SINK = failureSink({
  event: "file_conversion.image_embed_failed",
  expected: [],
});

const PDF_RENDER_FAILED_SINK = failureSink({
  event: "file_conversion.render_failed",
  expected: [],
});

/** Convertible types the converter receives: everything stella does not render. */
type ConverterMime = Exclude<ConvertibleMime, RenderedPdfMimeType>;

/**
 * Extensions the converter's LibreOffice route accepts for each convertible
 * type, canonical first. The route picks its import filter by the uploaded
 * filename's extension and refuses one it does not list, so a file named
 * without one, or with one the route does not take (a WordPerfect `.wp5`),
 * would fail to convert. Images, plain text and CSV never reach the route.
 * A converted document format names its one extension in its registry
 * entry.
 */
const CONVERTER_EXTENSIONS = {
  "application/msword": ["doc", "dot"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "pptx",
    "pptm",
    "potx",
    "potm",
    "ppsx",
    "ppsm",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    "xlsx",
    "xlsm",
    "xltx",
    "xltm",
  ],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
    "docm",
    "dotx",
    "dotm",
  ],
  "application/vnd.ms-excel": ["xls", "xlt"],
  "application/vnd.ms-powerpoint": ["ppt", "pot", "pps"],
  "application/vnd.oasis.opendocument.presentation": ["odp", "otp"],
  "application/vnd.oasis.opendocument.spreadsheet": ["ods", "ots"],
  "application/vnd.oasis.opendocument.text": ["odt", "ott"],
  "application/rtf": ["rtf"],
  "application/xhtml+xml": ["xhtml", "html", "htm"],
  "text/html": ["html", "htm"],
} as const satisfies Record<
  Exclude<ConverterMime, ConvertedDocumentMimeType>,
  readonly [string, ...string[]]
>;

/** The extensions the converter accepts for `mimeType`, canonical first. */
const converterExtensions = (
  mimeType: ConverterMime,
): readonly [string, ...string[]] => {
  if (!isConvertedDocumentMimeType(mimeType)) {
    return CONVERTER_EXTENSIONS[mimeType];
  }
  const converted =
    convertedDocumentFormatOfMimeType(mimeType) ??
    panic(`No converted format declares ${mimeType}`);
  return [converted.converterExtension.slice(1)];
};

/**
 * The (unsanitized) name to upload a file to the converter under. A file
 * keeps its extension when it is one the converter accepts for the file's
 * type; a missing or other extension is replaced by the type's canonical one.
 */
const withConverterExtension = (
  fileName: string,
  mimeType: ConverterMime,
): string => {
  const accepted: readonly string[] = converterExtensions(mimeType);
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
  const [canonical] = converterExtensions(mimeType);
  return `${stem}.${canonical}`;
};

/** A file name without its extension, for the HTML a document renders to. */
const fileStem = (fileName: string): string => {
  const segmentStart =
    Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1;
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > segmentStart ? fileName.slice(0, lastDot) : fileName;
};

/** The HTML a web archive or an e-book renders to. */
const renderDocumentHtml = async (
  mimeType: HtmlRenderedDocumentMimeType,
  bytes: Uint8Array,
): Promise<Result<Uint8Array, WebArchiveError | EbookError>> => {
  const format = htmlRenderedDocumentFormatOfMimeType(mimeType);
  switch (format?.mimeType) {
    case "application/epub+zip":
      return await ebookToHtml(bytes);
    case "multipart/related":
      return await webArchiveToHtml(bytes);
    case undefined:
      return panic(`No HTML-rendered format declares ${mimeType}`);
    default:
      format satisfies never;
      return panic("Unhandled HTML-rendered format");
  }
};

const gotenbergAuth = (): string =>
  basicAuthorizationHeader(
    envConverter.GOTENBERG_USERNAME,
    envConverter.GOTENBERG_PASSWORD,
  );

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
  /**
   * Whether HEIC/HEIF photos are decoded for their preview. Defaults to the
   * deployment's `HEIC_PREVIEW_DECODING_ENABLED`.
   */
  heifDecoding?: boolean;
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
 * Render a file stella lays out itself in the PDF worker subprocess, so
 * decoding and layout never hold the API's event loop and the timeout can
 * stop them. One attempt: the same bytes render the same way every time.
 *
 * Renders queue for the process's `pdf-render` work pool, so a process runs
 * `LIMITS.workPoolPdfRenderSlots` workers at once, and each worker is killed
 * past `LIMITS.pdfRenderWorkerRssMaxBytes`: together they bound what
 * rendering adds to the container's memory.
 */
const renderPdfInWorker = async (
  declaredType: string,
  bytes: Uint8Array,
): Promise<Result<ConvertToPdfResult, PdfRenderError>> => {
  const admitted = await admitWork({
    pool: "pdf-render",
    kind: "render-pdf",
    bytes: bytes.byteLength,
    run: async ({ signal }) =>
      await spawnBinaryWorker({
        workerPath: pdfWorkerPath(),
        args: [PDF_WORKER_OPERATION.render, declaredType],
        stdin: new Blob([bytes]),
        timeoutMs: LIMITS.pdfRenderTimeoutMs,
        signal,
        // The worker refuses a larger PDF itself; this bounds what is read.
        maxOutputBytes: LIMITS.fileDerivativePdfMaxBytes,
        maxRssBytes: LIMITS.pdfRenderWorkerRssMaxBytes,
      }),
  });
  if (Result.isError(admitted)) {
    return Result.err(
      WorkRefusal.is(admitted.error)
        ? new PdfRenderError({
            message: "No PDF render slot came free",
            reason: "busy",
            cause: admitted.error,
          })
        : new PdfRenderError({
            message: "The PDF render did not finish",
            reason: "failed",
            cause: admitted.error,
          }),
    );
  }
  const rendered = admitted.value;
  if (Result.isOk(rendered)) {
    return Result.ok({
      buffer: toArrayBuffer(rendered.value),
      sizeBytes: rendered.value.byteLength,
    });
  }
  if (
    rendered.error.termination?.reason === SUBPROCESS_TERMINATION_REASON.memory
  ) {
    return Result.err(
      new PdfRenderError({
        message: `The PDF worker passed its ${LIMITS.pdfRenderWorkerRssMaxBytes}-byte memory ceiling`,
        reason: "memory",
        cause: rendered.error,
      }),
    );
  }
  const { exitCode } = rendered.error;
  if (exitCode === PDF_WORKER_PARSE_ERROR_EXIT_CODE) {
    return Result.err(
      new PdfRenderError({
        message: "The file could not be decoded",
        reason: "unreadable",
        cause: rendered.error,
      }),
    );
  }
  if (exitCode === PDF_WORKER_TOO_LARGE_EXIT_CODE) {
    return Result.err(
      new PdfRenderError({
        message: `The rendered PDF exceeds the ${LIMITS.fileDerivativePdfMaxBytes}-byte limit`,
        reason: "too-large",
        cause: rendered.error,
      }),
    );
  }
  return Result.err(
    new PdfRenderError({
      message: "The PDF worker did not finish",
      reason: "failed",
      cause: rendered.error,
    }),
  );
};

/**
 * A HEIC/HEIF photo, rendered by the PDF worker when `decoding` is on (the
 * deployment's `HEIC_PREVIEW_DECODING_ENABLED`). Decoding off, a container that
 * cannot be read and pictures the decoder refuses are each a `no_preview`
 * refusal, which the file's viewer shows with the original to download; a
 * photo over the decode budget is too large, as any image is.
 */
const convertHeifToPdf = async (
  mimeType: HeifMimeType,
  fileName: string,
  bytes: Uint8Array,
  decoding: boolean,
): Promise<Result<ConvertToPdfResult, ConvertToPdfError>> => {
  const noPreview = (cause: "decoding_off" | "unreadable") => {
    const reason = {
      kind: "no_preview",
      format: heifFormatLabel(mimeType, fileName),
      cause,
    } as const;
    return Result.err(
      new ConversionInputError({
        message: conversionInputRefusalMessage(reason),
        reason,
      }),
    );
  };
  if (!decoding) {
    return noPreview("decoding_off");
  }
  const admission = admitDerivativeImage(bytes, mimeType);
  if (admission.type === "refused") {
    return admission.error.refusal === DERIVATIVE_REFUSAL.UNREADABLE_HEADER
      ? noPreview("unreadable")
      : Result.err(admission.error);
  }
  const rendered = await renderPdfInWorker(mimeType, bytes);
  if (Result.isOk(rendered)) {
    return rendered;
  }
  observeFailure(rendered.error, {
    sink: PDF_RENDER_FAILED_SINK,
    ctx: { operation: "render-pdf" },
  });
  return rendered.error.reason === "unreadable"
    ? noPreview("unreadable")
    : rendered;
};

/**
 * Convert a scanned file to PDF. Images are admitted by the pixel count
 * their header declares before anything decodes them. JPEG and PNG whose
 * header shows an encoding the in-process embedder handles become a
 * one-page PDF directly. Every other image (BMP, GIF first frame, every
 * page of a TIFF, WebP, JPEG and PNG encodings the embedder does not take,
 * and an embed that fails anyway), plain text and CSV are rendered by the
 * PDF worker; a failure there is observed and returned as a
 * `PdfRenderError`, never sent to the converter. Every other convertible
 * type goes to Gotenberg's LibreOffice route, once the input checks have
 * read it and its content is the format it is declared as. A type that is
 * not convertible never reaches the converter.
 */
export const convertToPdf = async (
  file: ScannedFile,
  {
    retry = "in-call",
    heifDecoding = envConverter.HEIC_PREVIEW_DECODING_ENABLED,
  }: ConvertToPdfOptions = {},
): Promise<Result<ConvertToPdfResult, ConvertToPdfError>> => {
  const { fileName } = file;
  // Decided on the type alone: a declared parameter (a charset, a boundary)
  // changes nothing about which route the file takes.
  const mimeType = mediaTypeEssence(file.mimeType);
  const bytes = new Uint8Array(file.bytes);
  if (isHeifMimeType(mimeType)) {
    return await convertHeifToPdf(mimeType, fileName, bytes, heifDecoding);
  }
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
    const embedded = await embedImage(bytes, header, mimeType);
    // An embed failure never reaches the caller (the worker renders the
    // image instead), so only the value crosses into the caller-facing type.
    if (Result.isOk(embedded)) {
      return Result.ok(embedded.value);
    }
    // The header promised an encoding the embedder then refused.
    observeFailure(embedded.error, {
      sink: IMAGE_EMBED_FAILED_SINK,
      ctx: { operation: "image-to-pdf" },
    });
  }

  if (isRenderedPdfMimeType(mimeType)) {
    // The declared type keeps its parameters: a text file's charset.
    const rendered = await renderPdfInWorker(file.mimeType, bytes);
    if (Result.isError(rendered)) {
      observeFailure(rendered.error, {
        sink: PDF_RENDER_FAILED_SINK,
        ctx: { operation: "render-pdf" },
      });
    }
    return rendered;
  }

  // A web archive or an e-book converts as the HTML stella builds from it,
  // under the same checks as any HTML file.
  const prepared = await documentSource(fileName, mimeType, bytes);
  if (Result.isError(prepared)) {
    return prepared;
  }
  const {
    fileName: documentName,
    mimeType: documentType,
    bytes: documentBytes,
  } = prepared.value;
  // Rendered types returned above; an HTML rendering is never one of them.
  if (
    !isConvertibleMimeType(documentType) ||
    isRenderedPdfMimeType(documentType)
  ) {
    return Result.err(
      new ConversionInputError({
        message: `Files of type ${documentType} cannot be converted.`,
        reason: { kind: "inspection_failed" },
      }),
    );
  }
  const inspection = await Result.tryPromise({
    try: async () => await checkConversionInput(documentType, documentBytes),
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
  // The converter opens a file by its content: the inspection above holds
  // only for a file that is the format it was inspected as.
  const contentMatches = await Result.tryPromise({
    try: async () =>
      await contentMatchesConvertibleMime(documentType, documentBytes),
    catch: (cause) =>
      new ConversionInputError({
        message: "The document could not be inspected for conversion.",
        reason: { kind: "inspection_failed" },
        cause,
      }),
  });
  if (Result.isError(contentMatches)) {
    return contentMatches;
  }
  if (!contentMatches.value) {
    return Result.err(
      new ConversionInputError({
        message: `The document's content is not the ${documentType} format it is declared as.`,
        reason: { kind: "inspection_failed" },
      }),
    );
  }

  const converted = await Result.tryPromise(
    {
      try: async () => {
        const source = XLSX_MIME_TYPES.has(documentType)
          ? new Uint8Array(await applyFitToPage(toArrayBuffer(documentBytes)))
          : documentBytes;
        // Streamed from the caller's buffer, so the request holds no second
        // copy of the source.
        const form = streamMultipartForm({
          file: {
            fieldName: "files",
            // The converter picks its import filter by extension.
            fileName: sanitizeFilenamePreservingExtension(
              withConverterExtension(documentName, documentType),
            ),
            bytes: source,
          },
          fields: { exportNotes: "true", exportNotesInMargin: "true" },
        });
        const target = gotenbergConvertTarget(envConverter);
        const response = await fetchWithTimeout(target, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: gotenbergAuth(),
            "Content-Type": form.contentType,
            "Content-Length": String(form.contentLength),
          },
          body: form.body,
          timeoutMs: 30_000,
        });

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

type DocumentSource = {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
};

/**
 * What the converter receives for a document: the file itself, or for a
 * format rendered from HTML, the HTML built from it under an `.html` name.
 */
const documentSource = async (
  uploadedName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<Result<DocumentSource, ConversionInputError>> => {
  if (!isHtmlRenderedMimeType(mimeType)) {
    return Result.ok({
      fileName: sanitizeFilenamePreservingExtension(uploadedName),
      mimeType,
      bytes,
    });
  }
  const rendered = await renderDocumentHtml(mimeType, bytes);
  if (Result.isError(rendered)) {
    return Result.err(
      new ConversionInputError({
        message: rendered.error.message,
        reason: { kind: "inspection_failed" },
        cause: rendered.error,
      }),
    );
  }
  return Result.ok({
    fileName: sanitizeFilenamePreservingExtension(
      `${fileStem(uploadedName)}.html`,
    ),
    mimeType: "text/html",
    bytes: rendered.value,
  });
};
