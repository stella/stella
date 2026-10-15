import { deflateSync } from "node:zlib";

import type { ImageOrientation } from "@/api/lib/files/image-header";

const RED = [255, 0, 0] as const;
const BLUE = [0, 0, 255] as const;

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, Bun.hash.crc32(crcInput));
  return chunk;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const ihdrChunk = ({
  bitDepth,
  colorType,
  height,
  interlaced,
  width,
}: {
  bitDepth: number;
  colorType: number;
  height: number;
  interlaced: boolean;
  width: number;
}) => {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlaced ? 1 : 0;
  return pngChunk("IHDR", ihdr);
};

/** 8-bit PNG colour types {@link splitPng} can write. */
type SplitPngColor = "rgb" | "rgba" | "palette";

const SPLIT_PNG_LAYOUT = {
  rgb: { colorType: 2, channels: 3 },
  rgba: { colorType: 6, channels: 4 },
  palette: { colorType: 3, channels: 1 },
} as const satisfies Record<
  SplitPngColor,
  { colorType: number; channels: number }
>;

/** An 8-bit PNG whose left half is red and right half blue. */
export const splitPng = (
  width: number,
  height: number,
  color: SplitPngColor = "rgb",
): Uint8Array => {
  const { channels, colorType } = SPLIT_PNG_LAYOUT[color];
  const pixel = (left: boolean): readonly number[] => {
    if (color === "palette") {
      return [left ? 0 : 1];
    }
    const rgb = left ? RED : BLUE;
    return color === "rgba" ? [...rgb, 255] : rgb;
  };
  const stride = 1 + width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows.set(pixel(x < width / 2), y * stride + 1 + x * channels);
    }
  }
  return concat([
    PNG_SIGNATURE,
    ihdrChunk({ bitDepth: 8, colorType, height, interlaced: false, width }),
    ...(color === "palette"
      ? [pngChunk("PLTE", Uint8Array.from([...RED, ...BLUE]))]
      : []),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
};

/**
 * A PNG header with no image data: only its IHDR fields are meaningful, so
 * a decoder handed it fails while a header reader sees every field.
 */
export const declaredPng = ({
  bitDepth = 8,
  colorType = 2,
  height,
  interlaced = false,
  width,
}: {
  bitDepth?: number;
  colorType?: number;
  height: number;
  interlaced?: boolean;
  width: number;
}): Uint8Array =>
  concat([
    PNG_SIGNATURE,
    ihdrChunk({ bitDepth, colorType, height, interlaced, width }),
    pngChunk("IEND", new Uint8Array(0)),
  ]);

/** A PNG header declaring `width` x `height` with no image data at all. */
export const declaredSizePng = (width: number, height: number): Uint8Array =>
  declaredPng({ width, height });

/** An APP1 EXIF segment carrying only an Orientation tag. */
const exifOrientationSegment = (orientation: ImageOrientation): Uint8Array => {
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d], 0);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, 1);
  view.setUint16(10, 0x01_12);
  view.setUint16(12, 3);
  view.setUint32(14, 1);
  view.setUint16(18, orientation);
  view.setUint32(22, 0);
  const payload = concat([new TextEncoder().encode("Exif\0\0"), tiff]);
  const segment = new Uint8Array(4 + payload.length);
  segment.set([0xff, 0xe1], 0);
  new DataView(segment.buffer).setUint16(2, payload.length + 2);
  segment.set(payload, 4);
  return segment;
};

/**
 * `jpeg` with its frame header's component count rewritten, so the header
 * declares e.g. four components (CMYK) over the same scan data.
 */
export const withJpegComponents = (
  jpeg: Uint8Array,
  components: number,
): Uint8Array => {
  const copy = jpeg.slice();
  for (let offset = 2; offset + 9 < copy.length;) {
    const marker = copy[offset + 1] ?? 0;
    const length = (copy[offset + 2] ?? 0) * 256 + (copy[offset + 3] ?? 0);
    if (marker >= 0xc0 && marker <= 0xc2) {
      copy[offset + 9] = components;
      return copy;
    }
    offset += 2 + length;
  }
  return copy;
};

/** {@link splitPng} as a JPEG carrying an EXIF `orientation`. */
export const splitJpeg = async (
  width: number,
  height: number,
  orientation: ImageOrientation,
): Promise<Uint8Array> => {
  Bun.Image.backend = "bun";
  const jpeg = await new Bun.Image(splitPng(width, height))
    .jpeg({ quality: 95 })
    .bytes();
  // Splice the orientation segment in right after SOI.
  return concat([
    jpeg.subarray(0, 2),
    exifOrientationSegment(orientation),
    jpeg.subarray(2),
  ]);
};

/** {@link splitPng} as a lossless WebP. */
export const splitWebp = async (
  width: number,
  height: number,
): Promise<Uint8Array> => {
  Bun.Image.backend = "bun";
  return await new Bun.Image(splitPng(width, height))
    .webp({ lossless: true })
    .bytes();
};
