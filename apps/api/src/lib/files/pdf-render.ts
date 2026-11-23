/**
 * The PDF of a file stella renders itself (see `pdf-render-protocol.ts`).
 * Runs inside the PDF worker subprocess, never in the API process: decoding
 * and layout are synchronous work bounded only by the worker's timeout.
 *
 * What a render holds is bounded by the file's first part, never by all of
 * it, within the `PdfRenderBudget` the parent derived from its container's
 * memory (`pdf-render-budget.ts`):
 *
 * - TIFF: the first `imagePagesMax` pages, decoded one at a time by
 *   `tiff-pages.ts`, each with its own orientation and decoding to at most
 *   `tiffPageDecodedBytesMax`.
 * - Every other image type: at most `imageDecodedBytesMax` decoded, by Bun's
 *   built-in image pipeline in its static-codec mode (identical on Linux and
 *   macOS), which applies EXIF orientation, reads only the first frame of a
 *   GIF, scales the image down to `imagePixelsMax`, and re-encodes the
 *   pixels as an 8-bit PNG the embedder takes.
 * - An image larger than its budget is too large to preview, and so is one
 *   whose pages hold more than `LIMITS.fileDerivativePdfMaxBytes` of image
 *   data between them.
 * - Plain text and CSV: the first `textSourceBytesMax` bytes, decoded by
 *   their byte-order mark or declared charset, otherwise as UTF-8, and laid
 *   out by `text-preview-pdf.ts` on at most `textPagesMax` pages, held
 *   `textPagesPerFontRun` at a time.
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
  FULL_PDF_RENDER_BUDGET,
  type PdfRenderBudget,
} from "@/api/lib/files/pdf-render-budget";
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
  type TextPages,
  type TextPreviewSource,
} from "@/api/lib/files/text-preview-pdf";
import { readTiffPages } from "@/api/lib/files/tiff-pages";
import { LIMITS } from "@/api/lib/limits";

class PdfRenderInputError extends TaggedError("PdfRenderInputError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * A rendered preview; `too-large` when an image is past even the full
 * budget or its image data passed `LIMITS.fileDerivativePdfMaxBytes` before
 * the last page; `over-budget` when an image fits the full budget but not
 * this render's, so a render with more room left may take it.
 */
export type RenderedPdf =
  | { type: "pdf"; bytes: Uint8Array }
  | { type: "too-large" }
  | { type: "over-budget" };

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
  budget: PdfRenderBudget,
): Promise<Result<RenderedPdf, PdfRenderInputError>> => {
  const tiff = readTiffPages(bytes, {
    decodedBytesMax: budget.tiffPageDecodedBytesMax,
    pagesMax: budget.imagePagesMax,
  });
  if (Result.isError(tiff)) {
    if (tiff.error.reason !== "too-large") {
      return Result.err(
        new PdfRenderInputError({
          message: tiff.error.message,
          cause: tiff.error,
        }),
      );
    }
    const underFull = readTiffPages(bytes, {
      decodedBytesMax: FULL_PDF_RENDER_BUDGET.tiffPageDecodedBytesMax,
      pagesMax: budget.imagePagesMax,
    });
    return Result.ok({
      type: Result.isOk(underFull) ? "over-budget" : "too-large",
    });
  }
  const { count, pages } = tiff.value;
  const fonts = count > budget.imagePagesMax ? await loadStampFonts() : null;
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
 * The pipeline's image, scaled down to fit `targetPixels` when it is larger.
 * The box is square, so the scale is the same whichever way EXIF
 * orientation turns the image.
 */
const scaledImage = async (
  bytes: Uint8Array,
  { maxPixels, targetPixels }: { maxPixels: number; targetPixels: number },
): Promise<Bun.Image> => {
  const image = new Bun.Image(bytes, { maxPixels });
  const { height, width } = await new Bun.Image(bytes, {
    maxPixels,
  }).metadata();
  const scale = Math.sqrt(targetPixels / (width * height));
  if (scale >= 1) {
    return image;
  }
  const side = Math.floor(Math.max(width, height) * scale);
  return image.resize(side, side, { fit: "inside" });
};

const renderImage = async (
  mimeType: string,
  bytes: Uint8Array,
  budget: PdfRenderBudget,
): Promise<Result<RenderedPdf, PdfRenderInputError>> => {
  if (mimeType === "image/tiff") {
    return await renderTiff(bytes, budget);
  }
  const header = isHeaderReadableImageMimeType(mimeType)
    ? readImageHeader(bytes, mimeType)
    : null;
  const perPixel = decodedBytesPerPixel(header);
  const decodedBytes =
    header === null ? 0 : header.width * header.height * perPixel;
  if (decodedBytes > budget.imageDecodedBytesMax) {
    return Result.ok({
      type:
        decodedBytes > FULL_PDF_RENDER_BUDGET.imageDecodedBytesMax
          ? "too-large"
          : "over-budget",
    });
  }
  Bun.Image.backend = "bun";
  const png = await Result.tryPromise({
    try: async () =>
      // The pipeline reads the header itself too, so a header this module
      // did not read is held to the same budget.
      await (
        await scaledImage(bytes, {
          maxPixels: Math.floor(budget.imageDecodedBytesMax / perPixel),
          targetPixels: budget.imagePixelsMax,
        })
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

/** The longest byte sequence of one character in any charset decoded here. */
const SPLIT_CHARACTER_BYTES_MAX = 4;

/**
 * The start of a text file that its preview lays out: the first `limit`
 * bytes, decoded, and cut back to the
 * last line break among them, so the preview ends on a whole line (a whole
 * record of a CSV) and never on a character the cut split. Without a line
 * break, it ends where the decoding of a few bytes more agrees with it: a
 * character the cut split decodes differently once whole, while one the
 * file really holds, a replacement character included, does not.
 */
export const previewText = (
  bytes: Uint8Array,
  declaredType: string,
  limit: number,
): TextPreviewSource => {
  const decode = (end: number) =>
    decodeDeclared(bytes.subarray(0, end), { contentType: declaredType }).text;
  if (bytes.byteLength <= limit) {
    return { text: decode(bytes.byteLength), shortened: false };
  }
  const text = decode(limit);
  const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  if (lastBreak !== -1) {
    return {
      // A CRLF cut after its LF keeps no stray CR.
      text: text.slice(0, lastBreak).replace(/\r$/u, ""),
      shortened: true,
    };
  }
  const further = decode(limit + SPLIT_CHARACTER_BYTES_MAX);
  let agreed = 0;
  while (agreed < text.length && text[agreed] === further[agreed]) {
    agreed += 1;
  }
  return { text: text.slice(0, agreed), shortened: true };
};

const renderText = async (
  mimeType: string,
  source: TextPreviewSource,
  fonts: StampFonts,
  pages: TextPages,
): Promise<RenderedPdf> => ({
  type: "pdf",
  bytes:
    mimeType === "text/csv"
      ? await csvToPdf(source, fonts, pages)
      : await plainTextToPdf(source, fonts, pages),
});

/**
 * Render `bytes`, declared as `declaredType` (parameters such as a charset
 * included), as a PDF within `budget`. A file the decoders refuse is a
 * `PdfRenderInputError`; anything else that fails is a defect and throws.
 */
export const renderPdf = async (
  declaredType: string,
  bytes: Uint8Array,
  budget: PdfRenderBudget,
): Promise<Result<RenderedPdf, PdfRenderInputError>> => {
  const mimeType = mediaTypeEssence(declaredType);
  if (!isRenderedPdfMimeType(mimeType)) {
    return panic(`${mimeType} is not rendered in-process`);
  }
  const kind = RENDERED_PDF_MIME_TYPES[mimeType];
  switch (kind) {
    case "image": {
      return await renderImage(mimeType, bytes, budget);
    }
    case "text": {
      return Result.ok(
        await renderText(
          mimeType,
          previewText(bytes, declaredType, budget.textSourceBytesMax),
          await loadStampFonts(),
          {
            pagesMax: budget.textPagesMax,
            pagesPerFontRun: budget.textPagesPerFontRun,
          },
        ),
      );
    }
    default: {
      kind satisfies never;
      return panic("Unhandled rendered PDF type");
    }
  }
};
