/**
 * The PDF of a file stella renders itself (see `pdf-render-protocol.ts`).
 * Runs inside the PDF worker subprocess, never in the API process: decoding
 * and layout are synchronous work bounded only by the worker's timeout.
 *
 * - TIFF: every page, decoded by `tiff-pages.ts`, each with its own
 *   orientation.
 * - Every other image type: decoded by Bun's built-in image pipeline in
 *   its static-codec mode (identical on Linux and macOS), which applies
 *   EXIF orientation, reads only the first frame of a GIF, and re-encodes
 *   the pixels as an 8-bit PNG the embedder takes.
 * - Plain text and CSV: decoded by their byte-order mark or declared
 *   charset, otherwise as UTF-8, and laid out by `text-preview-pdf.ts`.
 */

import { panic, Result, TaggedError } from "better-result";

import { decodeDeclared } from "@stll/mojibake/declared-charset";

import { imagePagesToPdf } from "@/api/lib/files/image-pdf";
import { mediaTypeEssence } from "@/api/lib/files/pdf-derivative-policy";
import {
  isRenderedPdfMimeType,
  RENDERED_PDF_MIME_TYPES,
} from "@/api/lib/files/pdf-render-protocol";
import { loadStampFonts } from "@/api/lib/files/pdf-signing/stamp-font";
import { readPngPixels } from "@/api/lib/files/png-pixels";
import { csvToPdf, plainTextToPdf } from "@/api/lib/files/text-preview-pdf";
import { readTiffPages } from "@/api/lib/files/tiff-pages";
import { LIMITS } from "@/api/lib/limits";

class PdfRenderInputError extends TaggedError("PdfRenderInputError")<{
  message: string;
  cause?: unknown;
}> {}

const renderImage = async (
  mimeType: string,
  bytes: Uint8Array,
): Promise<Result<Uint8Array, PdfRenderInputError>> => {
  if (mimeType === "image/tiff") {
    const tiff = readTiffPages(bytes, LIMITS.imageDerivativeSourcePixelsMax);
    if (Result.isError(tiff)) {
      return Result.err(
        new PdfRenderInputError({
          message: tiff.error.message,
          cause: tiff.error,
        }),
      );
    }
    return await Result.tryPromise({
      try: async () => await imagePagesToPdf(tiff.value.pages),
      catch: (cause) =>
        new PdfRenderInputError({
          message: "A TIFF page could not be decoded",
          cause,
        }),
    });
  }
  Bun.Image.backend = "bun";
  const png = await Result.tryPromise({
    try: async () =>
      await new Bun.Image(bytes, {
        maxPixels: LIMITS.imageDerivativeSourcePixelsMax,
      })
        // Stored, not compressed: the pixels are read straight back.
        .png({ compressionLevel: 0 })
        .bytes(),
    catch: (cause) =>
      new PdfRenderInputError({ message: "The image does not decode", cause }),
  });
  if (Result.isError(png)) {
    return png;
  }
  // The pipeline has applied any EXIF orientation to the pixels.
  const pixels = readPngPixels(png.value);
  return Result.ok(
    await imagePagesToPdf([
      pixels === null
        ? {
            kind: "encoded",
            mimeType: "image/png",
            bytes: png.value,
            orientation: 1,
          }
        : { kind: "rgba", ...pixels, orientation: 1 },
    ]),
  );
};

/**
 * Render `bytes`, declared as `declaredType` (parameters such as a charset
 * included), as a PDF. A file the decoders refuse is a `PdfRenderInputError`;
 * anything else that fails is a defect and throws.
 */
export const renderPdf = async (
  declaredType: string,
  bytes: Uint8Array,
): Promise<Result<Uint8Array, PdfRenderInputError>> => {
  const mimeType = mediaTypeEssence(declaredType);
  if (!isRenderedPdfMimeType(mimeType)) {
    return panic(`${mimeType} is not rendered in-process`);
  }
  const kind = RENDERED_PDF_MIME_TYPES[mimeType];
  switch (kind) {
    case "image": {
      return await renderImage(mimeType, bytes);
    }
    case "text": {
      const { text } = decodeDeclared(bytes, { contentType: declaredType });
      const fonts = await loadStampFonts();
      return Result.ok(
        mimeType === "text/csv"
          ? await csvToPdf(text, fonts)
          : await plainTextToPdf(text, fonts),
      );
    }
    default: {
      kind satisfies never;
      return panic("Unhandled rendered PDF type");
    }
  }
};
