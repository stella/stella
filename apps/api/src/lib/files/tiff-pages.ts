/**
 * The pages of a TIFF as decoded pixels, one image per page.
 *
 * Bun's image pipeline decodes TIFF only through the operating system's
 * codec, which the Linux build does not have, so TIFF is decoded by utif2
 * (MIT): every compression a scanned or faxed document uses (uncompressed,
 * PackBits, LZW, Deflate, CCITT G3/G4, JPEG), every bit depth, palette,
 * grey, RGB and CMYK, returned as 8-bit RGBA.
 *
 * Pages are the main directory chain. A directory flagged as a reduced
 * resolution copy of another page (NewSubfileType bit 0) is a thumbnail, not
 * a page. Each page carries its own orientation tag.
 */

import { panic, Result, TaggedError } from "better-result";
import * as UTIF from "utif2";

import type { ImageOrientation } from "@/api/lib/files/image-header";
import type { ImagePage } from "@/api/lib/files/image-pdf";

const NEW_SUBFILE_TYPE_TAG = "t254";
/** Bit 0 of NewSubfileType: a reduced-resolution copy of another page. */
const REDUCED_RESOLUTION = 1;
const IMAGE_WIDTH_TAG = "t256";
const IMAGE_HEIGHT_TAG = "t257";
const ORIENTATION_TAG = "t274";
const RGBA_CHANNELS = 4;

class TiffPagesError extends TaggedError("TiffPagesError")<{
  message: string;
  cause?: unknown;
}> {}

type TiffDirectory = ReturnType<typeof UTIF.decode>[number];

const firstNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return value;
  }
  // utif2 keeps a tag's values as a plain or typed array.
  const first: unknown =
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array
      ? value[0]
      : undefined;
  return typeof first === "number" ? first : null;
};

const isOrientation = (value: number | null): value is ImageOrientation =>
  value !== null && Number.isInteger(value) && value >= 1 && value <= 8;

type TiffPage = {
  directory: TiffDirectory;
  width: number;
  height: number;
  orientation: ImageOrientation;
};

type TiffPages = {
  /** How many pages the file shows. */
  count: number;
  /**
   * The pages, decoded one at a time as they are iterated, so only one
   * page's pixels are held at once.
   */
  pages: Iterable<ImagePage>;
};

/**
 * Read the page directories of `bytes` and check each page's declared size
 * against `maxPixels` before any pixels are decoded (admission has already
 * bounded the largest page the same way). Decoding a page that turns out to
 * be corrupt throws from the iterator.
 */
export const readTiffPages = (
  bytes: Uint8Array,
  maxPixels: number,
): Result<TiffPages, TiffPagesError> => {
  const buffer = bytes.slice().buffer;
  const directories = Result.try({
    try: () => UTIF.decode(buffer),
    catch: (cause) =>
      new TiffPagesError({ message: "The TIFF does not parse", cause }),
  });
  if (Result.isError(directories)) {
    return directories;
  }
  const pages: TiffPage[] = [];
  for (const directory of directories.value) {
    const subfileType = firstNumber(directory[NEW_SUBFILE_TYPE_TAG]) ?? 0;
    if (subfileType % 2 === REDUCED_RESOLUTION) {
      continue;
    }
    const width = firstNumber(directory[IMAGE_WIDTH_TAG]);
    const height = firstNumber(directory[IMAGE_HEIGHT_TAG]);
    if (width === null || height === null || width <= 0 || height <= 0) {
      continue;
    }
    if (width * height > maxPixels) {
      return Result.err(
        new TiffPagesError({
          message: `A TIFF page declares ${width * height} pixels, above the ${maxPixels}-pixel budget`,
        }),
      );
    }
    const orientation = firstNumber(directory[ORIENTATION_TAG]);
    pages.push({
      directory,
      width,
      height,
      orientation: isOrientation(orientation) ? orientation : 1,
    });
  }
  if (pages.length === 0) {
    return Result.err(
      new TiffPagesError({ message: "The TIFF has no page to show" }),
    );
  }
  const all = directories.value;
  return Result.ok({
    count: pages.length,
    pages: (function* decodePages() {
      for (const { directory, height, orientation, width } of pages) {
        UTIF.decodeImage(buffer, directory, all);
        const rgba = UTIF.toRGBA8(directory);
        // The page's compressed strips are no longer needed once decoded.
        directory.data = new Uint8Array();
        if (rgba.length !== width * height * RGBA_CHANNELS) {
          panic("A TIFF page decoded to another size than it declares");
        }
        yield { kind: "rgba", width, height, rgba, orientation } as const;
      }
    })(),
  });
};
