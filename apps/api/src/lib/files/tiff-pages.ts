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
const BITS_PER_SAMPLE_TAG = "t258";
const PHOTOMETRIC_TAG = "t262";
const SAMPLES_PER_PIXEL_TAG = "t277";
const STRIP_OFFSETS_TAG = "t273";
const STRIP_BYTE_COUNTS_TAG = "t279";
const TILE_OFFSETS_TAG = "t324";
const TILE_BYTE_COUNTS_TAG = "t325";
/** PhotometricInterpretation 5: separated, which is CMYK in practice. */
const PHOTOMETRIC_SEPARATED = 5;
const RGBA_CHANNELS = 4;

class TiffPagesError extends TaggedError("TiffPagesError")<{
  message: string;
  cause?: unknown;
}> {}

type TiffDirectory = ReturnType<typeof UTIF.decode>[number];

/**
 * utif2's page decoder. Its published types omit the third parameter, the
 * file's other directories, which an old-style JPEG page reads its tables
 * from.
 */
const decodeImage: (
  buffer: ArrayBuffer,
  directory: TiffDirectory,
  directories: readonly TiffDirectory[],
) => void = UTIF.decodeImage;

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

/** A tag's values as numbers, or `null` when it is absent or not numeric. */
const numbers = (value: unknown): number[] | null => {
  if (!(
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    value instanceof Uint16Array ||
    value instanceof Uint32Array
  )) {
    return null;
  }
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number") {
      return null;
    }
    out.push(entry);
  }
  return out;
};

/**
 * Whether every strip or tile of a page lies inside the file. utif2 reads
 * bytes past the end as zero, so a cut-short file would otherwise decode to
 * a page of blank pixels.
 */
const dataWithinFile = (directory: TiffDirectory, fileLength: number) => {
  const tiled = directory[TILE_OFFSETS_TAG] !== undefined;
  const offsets = numbers(
    directory[tiled ? TILE_OFFSETS_TAG : STRIP_OFFSETS_TAG],
  );
  const counts = numbers(
    directory[tiled ? TILE_BYTE_COUNTS_TAG : STRIP_BYTE_COUNTS_TAG],
  );
  return (
    offsets !== null &&
    counts !== null &&
    offsets.length > 0 &&
    offsets.length === counts.length &&
    offsets.every(
      (offset, index) => offset + (counts[index] ?? 0) <= fileLength,
    )
  );
};

/**
 * An 8-bit CMYK page as RGBA, by the same naive conversion utif2 uses. utif2
 * itself reaches for a browser global on this path, which a worker has not.
 */
const cmykToRgba = (
  directory: TiffDirectory,
  width: number,
  height: number,
) => {
  const samples = firstNumber(directory[SAMPLES_PER_PIXEL_TAG]) ?? 4;
  const { data } = directory;
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * RGBA_CHANNELS);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const source = pixel * samples;
    const black = (255 - (data[source + 3] ?? 0)) / 255;
    const target = pixel * RGBA_CHANNELS;
    rgba[target] = Math.round((255 - (data[source] ?? 0)) * black);
    rgba[target + 1] = Math.round((255 - (data[source + 1] ?? 0)) * black);
    rgba[target + 2] = Math.round((255 - (data[source + 2] ?? 0)) * black);
    rgba[target + 3] = samples > 4 ? (data[source + 4] ?? 255) : 255;
  }
  return rgba;
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
    if (!dataWithinFile(directory, bytes.length)) {
      return Result.err(
        new TiffPagesError({
          message: "A TIFF page's image data lies outside the file",
        }),
      );
    }
    const separated =
      firstNumber(directory[PHOTOMETRIC_TAG]) === PHOTOMETRIC_SEPARATED;
    if (separated && firstNumber(directory[BITS_PER_SAMPLE_TAG]) !== 8) {
      return Result.err(
        new TiffPagesError({
          message: "A CMYK TIFF page is not 8 bits per sample",
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
        decodeImage(buffer, directory, all);
        const rgba =
          firstNumber(directory[PHOTOMETRIC_TAG]) === PHOTOMETRIC_SEPARATED
            ? cmykToRgba(directory, width, height)
            : UTIF.toRGBA8(directory);
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
