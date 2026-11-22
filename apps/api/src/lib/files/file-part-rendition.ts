/**
 * What a part of a stored file displays as. A document no viewer draws as it
 * is (a Word 97 file, an OpenDocument text, a WordPerfect file) displays as
 * the PDF the converter makes of it, the way a stored file of the type
 * displays its PDF rendition: the same admission, scan and conversion, so a
 * file inside a container previews as it would on its own. Any other part
 * displays as itself.
 */
import { Result } from "better-result";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { isFilePartConvertedMediaType } from "@stll/api-contract/file-parts";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import {
  admitDerivativeSourceBytes,
  DerivativeAdmissionError,
} from "@/api/lib/files/derivative-admission";
import type { FilePartRead } from "@/api/lib/files/file-part";
import {
  ConversionInputError,
  convertToPdf,
  PdfRenderError,
} from "@/api/lib/files/gotenberg";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/** The name a part's PDF rendition is delivered under. */
export const pdfRenditionFileName = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return `${dot <= 0 ? fileName : fileName.slice(0, dot)}.pdf`;
};

/**
 * What the part link names a part delivered for display: its PDF rendition
 * for a converted type, else the part itself. The grant is issued under this
 * name and type, so a client opens it as what it will receive.
 */
export const filePartDisplayIdentity = ({
  fileName,
  mimeType,
}: Pick<FilePartRead, "fileName" | "mimeType">) =>
  isFilePartConvertedMediaType(mimeType)
    ? { fileName: pdfRenditionFileName(fileName), mimeType: PDF_MIME_TYPE }
    : { fileName, mimeType };

const notConverted = (message: string, cause?: unknown) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * The part as it displays: a converted type's PDF, made from the part's
 * scanned bytes, or the part unchanged. A part the conversion refuses (too
 * large, a format the converter's checks turn away, a document it cannot
 * render) has no preview; a converter that does not answer is unavailable.
 */
export const filePartForDisplay = async (
  part: FilePartRead,
): Promise<Result<FilePartRead, HandlerError>> => {
  if (!isFilePartConvertedMediaType(part.mimeType)) {
    return Result.ok(part);
  }
  const admission = admitDerivativeSourceBytes(part.bytes.byteLength);
  if (admission !== null) {
    return Result.err(
      notConverted("The file is too large to preview", admission),
    );
  }
  // The part was scanned when it was read; the converter takes only a
  // `ScannedFile`, which this scan of the same bytes yields.
  const scanned = await scanUpload({
    bytes: part.bytes,
    declaredMimeType: part.mimeType,
    fileName: sanitizeFilenamePreservingExtension(part.fileName),
  });
  if (Result.isError(scanned)) {
    return Result.err(
      FileScanRejectedError.is(scanned.error)
        ? notConverted("An embedded file did not pass the security scan")
        : new HandlerError({
            status: 503,
            code: "upstream_unavailable",
            message: "The file security scan is unavailable",
            cause: scanned.error,
          }),
    );
  }
  const converted = await convertToPdf(scanned.value);
  if (Result.isError(converted)) {
    const { error } = converted;
    if (
      error instanceof ConversionInputError ||
      error instanceof DerivativeAdmissionError ||
      (error instanceof PdfRenderError && error.reason !== "failed")
    ) {
      return Result.err(
        notConverted("The file could not be converted for preview", error),
      );
    }
    return Result.err(
      new HandlerError({
        status: 502,
        code: "upstream_unavailable",
        message: "The document converter is unavailable",
        cause: error,
      }),
    );
  }
  return Result.ok({
    bytes: new Uint8Array(converted.value.buffer),
    ...filePartDisplayIdentity(part),
  });
};
