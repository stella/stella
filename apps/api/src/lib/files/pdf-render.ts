/**
 * The PDF of a file stella renders itself (see `pdf-render-protocol.ts`).
 * Runs inside the PDF worker subprocess, never in the API process: decoding
 * and layout are synchronous work bounded only by the worker's timeout.
 *
 * What a render holds is bounded by the file's first part, never by all of
 * it:
 *
 * - TIFF: the first `LIMITS.pdfRenderImagePagesMax` pages, decoded one at a
 *   time by `tiff-pages.ts`, each with its own orientation and decoding to
 *   at most `LIMITS.pdfRenderTiffPageDecodedBytesMax`.
 * - Every other image type: at most `LIMITS.pdfRenderImageDecodedBytesMax`
 *   decoded, by Bun's built-in image pipeline in its static-codec mode
 *   (identical on Linux and macOS), which applies EXIF orientation, reads
 *   only the first frame of a GIF, scales the image down to
 *   `LIMITS.pdfRenderImagePixelsMax`, and re-encodes the pixels as an 8-bit
 *   PNG the embedder takes.
 * - An image larger than its budget is too large to preview, and so is one
 *   whose pages hold more than `LIMITS.fileDerivativePdfMaxBytes` of image
 *   data between them.
 * - Plain text and CSV: the first `LIMITS.pdfRenderTextSourceBytesMax`
 *   bytes, decoded by their byte-order mark or declared charset, otherwise
 *   as UTF-8, and laid out by `text-preview-pdf.ts` on at most
 *   `LIMITS.pdfRenderTextPagesMax` pages.
 *
 * A preview that leaves part of the file out ends with a page saying so.
 */

import { panic, Result, TaggedError } from "better-result";

import { decodeDeclared } from "@stll/mojibake/declared-charset";

import {
  type ImageHeader,
  isHeaderReadableImageMimeType,
  readImageHeader,
} from "@/api/lib/files/image-header";
import { type ImagePage, imagePagesToPdf } from "@/api/lib/files/image-pdf";
import { mediaTypeEssence } from "@/api/lib/files/pdf-derivative-policy";
import {
  isRenderedPdfMimeType,
  RENDERED_PDF_MIME_TYPES,
} from "@/api/lib/files/pdf-render-protocol";
import {
  loadStampFonts,
  type StampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import { readPngPixels } from "@/api/lib/files/png-pixels";
import {
  addShortenedNotePage,
  csvToPdf,
  plainTextToPdf,
  type TextPreviewSource,
} from "@/api/lib/files/text-preview-pdf";
import { readTiffPages } from "@/api/lib/files/tiff-pages";
import { LIMITS } from "@/api/lib/limits";

class PdfRenderInputError extends TaggedError("PdfRenderInputError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * A rendered preview, or `too-large` when its image data passed
 * `LIMITS.fileDerivativePdfMaxBytes` before the last page.
 */
export type RenderedPdf =
  { type: "pdf"; bytes: Uint8Array } | { type: "too-large" };

/**
 * The render runs in a process of its own, so a full collection between
 * decoded pages returns one page's pixels before the next page's are made,
 * instead of whenever the heap next grows.
 */
function* collectedBetween(
  pages: Iterable<ImagePage>,
): Generator<ImagePage, void, undefined> {
  for (const page of pages) {
    yield page;
    Bun.gc(true);
  }
}

const renderTiff = async (
  bytes: Uint8Array,
): Promise<Result<RenderedPdf, PdfRenderInputError>> => {
  const tiff = readTiffPages(bytes, {
    decodedBytesMax: LIMITS.pdfRenderTiffPageDecodedBytesMax,
    pagesMax: LIMITS.pdfRenderImagePagesMax,
  });
  if (Result.isError(tiff)) {
    return tiff.error.reason === "too-large"
      ? Result.ok({ type: "too-large" })
      : Result.err(
          new PdfRenderInputError({
            message: tiff.error.message,
            cause: tiff.error,
          }),
        );
  }
  const { count, pages } = tiff.value;
  const fonts =
    count > LIMITS.pdfRenderImagePagesMax ? await loadStampFonts() : null;
  return await Result.tryPromise({
    try: async () =>
      await imagePagesToPdf(collectedBetween(pages), {
        maxBytes: LIMITS.fileDerivativePdfMaxBytes,
        ...(fonts === null
          ? {}
          : { finish: (pdf) => addShortenedNotePage(pdf, fonts) }),
      }),
    catch: (cause) =>
      new PdfRenderInputError({
        message: "A TIFF page could not be decoded",
        cause,
      }),
  });
};

/** Bytes Bun's pipeline holds per decoded pixel: RGBA, 16 bits a sample for a 16-bit PNG. */
const decodedBytesPerPixel = (header: ImageHeader | null) =>
  header?.encoding?.format === "png" && header.encoding.bitDepth === 16 ? 8 : 4;

/**
 * The pipeline's image, scaled down to fit `LIMITS.pdfRenderImagePixelsMax`
 * when it is larger. The box is square, so the scale is the same whichever
 * way EXIF orientation turns the image.
 */
const scaledImage = async (
  bytes: Uint8Array,
  maxPixels: number,
): Promise<Bun.Image> => {
  const image = new Bun.Image(bytes, { maxPixels });
  const { height, width } = await new Bun.Image(bytes, {
    maxPixels,
  }).metadata();
  const scale = Math.sqrt(LIMITS.pdfRenderImagePixelsMax / (width * height));
  if (scale >= 1) {
    return image;
  }
  const side = Math.floor(Math.max(width, height) * scale);
  return image.resize(side, side, { fit: "inside" });
};

const renderImage = async (
  mimeType: string,
  bytes: Uint8Array,
): Promise<Result<RenderedPdf, PdfRenderInputError>> => {
  if (mimeType === "image/tiff") {
    return await renderTiff(bytes);
  }
  const header = isHeaderReadableImageMimeType(mimeType)
    ? readImageHeader(bytes, mimeType)
    : null;
  const perPixel = decodedBytesPerPixel(header);
  if (
    header !== null &&
    header.width * header.height * perPixel >
      LIMITS.pdfRenderImageDecodedBytesMax
  ) {
    return Result.ok({ type: "too-large" });
  }
  Bun.Image.backend = "bun";
  const png = await Result.tryPromise({
    try: async () =>
      // The pipeline reads the header itself too, so a header this module
      // did not read is held to the same budget.
      await (
        await scaledImage(
          bytes,
          Math.floor(LIMITS.pdfRenderImageDecodedBytesMax / perPixel),
        )
      )
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
  const page: ImagePage =
    pixels === null
      ? {
          kind: "encoded",
          mimeType: "image/png",
          bytes: png.value,
          orientation: 1,
        }
      : { kind: "rgba", ...pixels, orientation: 1 };
  return Result.ok(
    await imagePagesToPdf(collectedBetween([page]), {
      maxBytes: LIMITS.fileDerivativePdfMaxBytes,
    }),
  );
};

/**
 * The start of a text file that its preview lays out: the first
 * `LIMITS.pdfRenderTextSourceBytesMax` bytes, decoded, and cut back to the
 * last line break among them, so the preview ends on a whole line (a whole
 * record of a CSV) and never on a character the cut split. Without a line
 * break, only the replacement character a split one decodes to is dropped.
 */
export const previewText = (
  bytes: Uint8Array,
  declaredType: string,
): TextPreviewSource => {
  const limit = LIMITS.pdfRenderTextSourceBytesMax;
  if (bytes.byteLength <= limit) {
    const { text } = decodeDeclared(bytes, { contentType: declaredType });
    return { text, shortened: false };
  }
  const { text } = decodeDeclared(bytes.subarray(0, limit), {
    contentType: declaredType,
  });
  const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return {
    text:
      lastBreak === -1
        ? text.replace(/�$/u, "")
        : // A CRLF cut after its LF keeps no stray CR.
          text.slice(0, lastBreak).replace(/\r$/u, ""),
    shortened: true,
  };
};

const renderText = async (
  mimeType: string,
  source: TextPreviewSource,
  fonts: StampFonts,
): Promise<RenderedPdf> => ({
  type: "pdf",
  bytes:
    mimeType === "text/csv"
      ? await csvToPdf(source, fonts)
      : await plainTextToPdf(source, fonts),
});

/**
 * Render `bytes`, declared as `declaredType` (parameters such as a charset
 * included), as a PDF. A file the decoders refuse is a `PdfRenderInputError`;
 * anything else that fails is a defect and throws.
 */
export const renderPdf = async (
  declaredType: string,
  bytes: Uint8Array,
): Promise<Result<RenderedPdf, PdfRenderInputError>> => {
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
      return Result.ok(
        await renderText(
          mimeType,
          previewText(bytes, declaredType),
          await loadStampFonts(),
        ),
      );
    }
    default: {
      kind satisfies never;
      return panic("Unhandled rendered PDF type");
    }
  }
};
