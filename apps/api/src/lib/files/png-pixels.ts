/**
 * The pixels of an 8-bit, non-interlaced RGB or RGBA PNG, as RGBA: what
 * Bun's image pipeline writes. Inflated with the platform's zlib and
 * unfiltered here, so a decoded image reaches the PDF without the JavaScript
 * inflate and deflate the embedder's own PNG path runs.
 */

import { Result } from "better-result";
import { inflateSync } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_TYPE_CHANNELS = new Map([
  [2, 3],
  [6, 4],
]);

export type PngPixels = { width: number; height: number; rgba: Uint8Array };

const paeth = (left: number, up: number, upLeft: number) => {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
};

type Predictor = (left: number, up: number, upLeft: number) => number;

/** What each PNG filter type (0 to 4) adds back to a filtered byte. */
const PREDICTORS: readonly Predictor[] = [
  () => 0,
  (left) => left,
  (_left, up) => up,
  (left, up) => Math.floor((left + up) / 2),
  paeth,
];

type PngLayout = {
  width: number;
  height: number;
  channels: number;
  /** The IDAT chunks' bodies, in order. */
  data: Uint8Array[];
};

/** The header and image data of a PNG this reads, or `null`. */
const readChunks = (png: Uint8Array): PngLayout | null => {
  if (!SIGNATURE.every((byte, index) => png[index] === byte)) {
    return null;
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = SIGNATURE.length;
  const layout: PngLayout = { channels: 0, data: [], height: 0, width: 0 };
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCodePoint(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) {
      return null;
    }
    if (type === "IHDR") {
      layout.width = view.getUint32(offset + 8);
      layout.height = view.getUint32(offset + 12);
      layout.channels = COLOR_TYPE_CHANNELS.get(png[offset + 17] ?? -1) ?? 0;
      // Only 8-bit, non-interlaced images.
      if (png[offset + 16] !== 8 || png[offset + 20] !== 0) {
        return null;
      }
    } else if (type === "IDAT") {
      layout.data.push(body);
    } else if (type === "IEND") {
      break;
    }
    // Length, type, body and CRC.
    offset += 12 + length;
  }
  const complete =
    layout.width > 0 &&
    layout.height > 0 &&
    layout.channels > 0 &&
    layout.data.length > 0;
  return complete ? layout : null;
};

/** Filtered scanlines back to RGBA, or `null` for an unknown filter type. */
const unfilter = (
  filtered: Uint8Array,
  { channels, height, width }: PngLayout,
): Uint8Array | null => {
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const predict = PREDICTORS[filtered[rowStart] ?? -1];
    if (predict === undefined) {
      return null;
    }
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (current[x - channels] ?? 0) : 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      // A Uint8Array stores the sum modulo 256, as the filters define it.
      current[x] =
        (filtered[rowStart + 1 + x] ?? 0) +
        predict(left, previous[x] ?? 0, upLeft);
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const source = x * channels;
      rgba[target] = current[source] ?? 0;
      rgba[target + 1] = current[source + 1] ?? 0;
      rgba[target + 2] = current[source + 2] ?? 0;
      rgba[target + 3] = channels === 4 ? (current[source + 3] ?? 0) : 255;
    }
    [previous, current] = [current, previous];
  }
  return rgba;
};

/**
 * The image's RGBA pixels, or `null` for any PNG this does not read (another
 * bit depth or colour type, interlacing, a malformed stream): the caller
 * then embeds the PNG as it is.
 */
export const readPngPixels = (png: Uint8Array): PngPixels | null => {
  const layout = readChunks(png);
  if (layout === null) {
    return null;
  }
  const inflated = Result.try(() => inflateSync(Buffer.concat(layout.data)));
  const scanlineBytes = (layout.width * layout.channels + 1) * layout.height;
  if (Result.isError(inflated) || inflated.value.length < scanlineBytes) {
    return null;
  }
  const rgba = unfilter(inflated.value, layout);
  return rgba === null
    ? null
    : { height: layout.height, rgba, width: layout.width };
};
